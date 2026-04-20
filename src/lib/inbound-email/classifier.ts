/**
 * Gemini-based classifier for inbound emails.
 *
 * Given raw email content + attachments + the tenant's active projects,
 * returns: classification (sub_quote | vendor_bill | other), extracted
 * structured data, and best-guess project match with confidence.
 */

import { GoogleGenAI } from '@google/genai';

export type Classification = 'sub_quote' | 'vendor_bill' | 'other';

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

const MODEL = 'gemini-2.5-flash';

export async function classifyInboundEmail(
  email: EmailContext,
  projects: ProjectContext[],
): Promise<ClassifierResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const ai = new GoogleGenAI({ apiKey });

  const projectList = projects
    .map(
      (p) =>
        `- id: ${p.id} | name: ${p.name}${p.customer_name ? ` | customer: ${p.customer_name}` : ''}`,
    )
    .join('\n');

  const prompt = `You are classifying an inbound email received by a general contractor's job cost control system. Determine if it contains a subcontractor quote, a vendor bill/invoice, or neither. Extract structured data if it's a quote or bill. Match it to one of the GC's active projects if you can.

CLASSIFICATION RULES:
- "sub_quote": A subcontractor is quoting work (e.g. "tiling quote for the ABC job", "here's my estimate for the bathroom"). Usually has line items with qty/unit/cost and a total.
- "vendor_bill": A supplier/vendor is billing for goods or services delivered (e.g. "invoice for lumber delivery", a PDF invoice with a due date/amount). Usually a single total amount.
- "other": Anything else (confirmations, personal messages, spam, newsletters).

PROJECT MATCHING:
- Look at subject + forwarding note + PDF content for project/customer references.
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
    "bill_number"?: string,
    "bill_date": "YYYY-MM-DD",
    "description"?: string,
    "amount_cents": integer,
    "cost_code"?: string
  },
  "project_match": null | {"id": "<uuid from list above>", "confidence": 0.0-1.0},
  "notes": "short explanation of your classification and match reasoning"
}`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];

  for (const att of email.attachments) {
    if (att.contentType === 'application/pdf' || att.contentType.startsWith('image/')) {
      parts.push({
        inlineData: {
          mimeType: att.contentType,
          data: att.base64,
        },
      });
    }
  }

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    },
  });

  const text = response.text ?? '';
  let parsed: ClassifierResult;
  try {
    parsed = JSON.parse(text) as ClassifierResult;
  } catch {
    throw new Error(`Gemini returned non-JSON response: ${text.slice(0, 200)}`);
  }

  return parsed;
}
