/**
 * AI gateway-backed classifier for inbound emails.
 *
 * Given raw email content + attachments + the tenant's active projects,
 * returns: classification (sub_quote | vendor_bill | other), extracted
 * structured data, and best-guess project match with confidence.
 *
 * Routes via the gateway under task='email_classify' — Gemini primary,
 * OpenAI fallback. See routing.ts.
 *
 * Robustness: validates the model's output against our enum. If the
 * model returns something off-spec (we've seen "unclassified" on
 * screenshots), we re-prompt once with a stricter instruction; if it
 * still misbehaves we coerce to "other" and prepend a warning to notes
 * so the operator can see what happened.
 */

import { type AttachedFile, gateway } from '@/lib/ai-gateway';

export type Classification = 'sub_quote' | 'vendor_bill' | 'other';

const VALID_CLASSIFICATIONS: readonly string[] = ['sub_quote', 'vendor_bill', 'other'];

export type ExtractedLineItem = {
  description: string;
  qty: number;
  unit: string;
  unit_cost_cents: number;
};

export type ExtractedSubQuote = {
  vendor: string;
  quote_number?: string;
  quote_date?: string;
  items: ExtractedLineItem[];
  total_cents: number;
  notes?: string;
};

export type ExtractedVendorBill = {
  vendor: string;
  vendor_gst_number?: string;
  bill_number?: string;
  bill_date: string;
  description?: string;
  amount_cents: number;
  cost_code?: string;
};

export type ClassifierResult = {
  classification: Classification;
  confidence: number;
  extracted: ExtractedSubQuote | ExtractedVendorBill | null;
  project_match: { id: string; confidence: number } | null;
  notes: string;
};

export type ProjectContext = {
  id: string;
  name: string;
  customer_name: string | null;
  description: string | null;
};

export type EmailContext = {
  from: string;
  from_name: string | null;
  subject: string;
  body_text: string;
  attachments: { filename: string; contentType: string; base64: string }[];
};

function buildPrompt(email: EmailContext, projectList: string, retry: boolean): string {
  const retryNote = retry
    ? `\n*** RETRY *** Your previous response used an invalid classification value. You MUST pick exactly one of: "sub_quote", "vendor_bill", "other". No other strings are allowed.\n`
    : '';
  return `You are classifying an inbound email received by a general contractor's job cost control system. Determine if it contains a subcontractor quote, a vendor bill/invoice, or neither. Extract structured data if it's a quote or bill. Match it to one of the GC's active projects if you can.
${retryNote}
CLASSIFICATION (REQUIRED — must be EXACTLY one of these three strings, no other values are valid):
- "sub_quote": A subcontractor is quoting work (e.g. "tiling quote for the ABC job", "here's my estimate for the bathroom"). Usually has line items with qty/unit/cost and a total.
- "vendor_bill": A supplier/vendor is billing for goods or services delivered. Includes receipts and screenshots of receipts (e.g. Home Depot purchase, lumber yard receipt). Usually a single total amount, vendor name visible somewhere.
- "other": Anything else (confirmations, personal messages, spam, newsletters). If you genuinely cannot tell what the attachment shows, pick "other" — do NOT invent new classification values.

If the email contains only a screenshot or photo of a printed receipt/invoice, treat that the same as a vendor_bill — extract what you can read from the image.

PROJECT MATCHING:
- Look at subject + forwarding note + PDF/image content for project/customer references.
- Match against the active projects below. Use name, address, customer name.
- If you're uncertain, return null (don't guess).
- Confidence 0.0-1.0. Only auto-assign if >= 0.8.

ACTIVE PROJECTS:
${projectList || '(none)'}

EMAIL:
From: ${email.from_name ? `${email.from_name} <${email.from}>` : email.from}
Subject: ${email.subject}

Body:
${email.body_text.slice(0, 8000)}

Return ONLY valid JSON matching this schema (no markdown, no prose):
{
  "classification": "sub_quote" | "vendor_bill" | "other",
  "confidence": 0.0-1.0,
  "extracted": null | {
    // For sub_quote:
    "vendor": string,
    "quote_number"?: string,
    "quote_date"?: "YYYY-MM-DD",
    "items": [{"description": string, "qty": number, "unit": string, "unit_cost_cents": integer}],
    "total_cents": integer,
    "notes"?: string
    // OR for vendor_bill:
    "vendor": string,
    "vendor_gst_number"?: string,  // Canadian GST/HST BN printed on the invoice (e.g. "123456789 RT0001" or 9-digit root). Labels: "GST Reg #", "HST #", "BN", "Business Number". Omit if not shown.
    "bill_number"?: string,
    "bill_date": "YYYY-MM-DD",
    "description"?: string,
    "amount_cents": integer,
    "cost_code"?: string
  },
  "project_match": null | {"id": "<uuid from list above>", "confidence": 0.0-1.0},
  "notes": "short explanation of your classification and match reasoning"
}`;
}

async function runClassifierOnce(args: {
  prompt: string;
  files: AttachedFile[];
  tenantId?: string | null;
}): Promise<ClassifierResult> {
  const res = await gateway().runStructured<ClassifierResult>({
    kind: 'structured',
    task: 'email_classify',
    tenant_id: args.tenantId,
    prompt: args.prompt,
    schema: { type: 'object' },
    files: args.files,
    temperature: 0.1,
  });
  return res.data;
}

export async function classifyInboundEmail(
  email: EmailContext,
  projects: ProjectContext[],
  tenantId?: string | null,
): Promise<ClassifierResult> {
  const projectList = projects
    .map(
      (p) =>
        `- id: ${p.id} | name: ${p.name}${p.customer_name ? ` | customer: ${p.customer_name}` : ''}`,
    )
    .join('\n');

  // Filter attachments to image / PDF (the only types the providers
  // accept inline). Drop everything else silently.
  const files: AttachedFile[] = email.attachments
    .filter((a) => a.contentType === 'application/pdf' || a.contentType.startsWith('image/'))
    .map((a) => ({ mime: a.contentType, base64: a.base64, filename: a.filename }));

  let result = await runClassifierOnce({
    prompt: buildPrompt(email, projectList, false),
    files,
    tenantId,
  });

  // If the model returned an invalid classification value (e.g. its own
  // invented "unclassified"), retry once with a stricter prompt.
  if (!VALID_CLASSIFICATIONS.includes(result.classification)) {
    const invalidValue = String(result.classification);
    result = await runClassifierOnce({
      prompt: buildPrompt(email, projectList, true),
      files,
      tenantId,
    });

    // Still invalid after retry — coerce to "other" with a visible note.
    if (!VALID_CLASSIFICATIONS.includes(result.classification)) {
      const coercionNote = `[classifier coerced to "other" — model returned invalid value "${invalidValue}" then "${result.classification}" on retry]`;
      return {
        classification: 'other',
        confidence: 0,
        extracted: null,
        project_match: null,
        notes: `${coercionNote} ${result.notes ?? ''}`.trim(),
      };
    }
  }

  return result;
}
