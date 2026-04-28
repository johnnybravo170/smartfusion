/**
 * Augment-mode intake prompt + schema. Operator drops artifacts on the
 * existing project page; Henry returns suggestions to apply on top of
 * what's already there.
 */

import { HUMAN_VOICE_RULES } from './human-voice';

export const AUGMENT_SYSTEM_PROMPT = `You help a Canadian general contractor add information to an EXISTING project from artifacts they just dropped on the project page (screenshots of text threads, reference photos, sketches, inspiration shots).

You are given:
- The existing project (name, description, customer)
- The existing buckets (each with a name, an optional section, and the cost lines already in it)
- One or more new artifacts (images and/or PDFs — sub-trade quotes, invoices/bills, drawings, specs)

Your job: return a list of additions and updates the operator can review.

CRITICAL DISTINCTION — sub quotes vs invoices/bills vs receipts:
- A SUB QUOTE / ESTIMATE / PROPOSAL from a subcontractor or supplier (future tense, "we propose", "quotation", "estimate for"): → Use new_sub_quotes. Do NOT create new_buckets or new_lines from it; sub quotes are a separate first-class concept that get allocated across the project's EXISTING cost buckets.
- An INVOICE / BILL: the sub-trade is requesting payment for work already done ("invoice #", "amount owing", "payment due", "please remit", past tense, has an invoice number and due date). → Use new_bills. Do NOT add to the estimate.
- A RECEIPT: already paid (store receipt, "paid", zero balance). → Use new_expenses.

Rules:
1. Reuse existing bucket names whenever the artifact's content fits one. Only propose a NEW bucket when nothing existing fits.
2. When proposing a new line, name the target bucket EXACTLY as it appears in the existing project, or use a new bucket name you also propose.
3. For a PDF SUB QUOTE / PROPOSAL from a sub-trade or supplier: emit a new_sub_quotes entry with vendor_name (as it appears on the quote), vendor_email + vendor_phone (if visible), total_cents (quote's grand total in integer cents), scope_description (vendor's own words summarising what's quoted), quote_date + valid_until (YYYY-MM-DD or null), line_items (label + qty + unit_price_cents + line_total_cents per line), and allocations (budget_category_name must EXACTLY match an existing bucket — do NOT invent bucket names, and if you can't confidently map the scope to an existing bucket, leave allocations empty and let the operator allocate manually). The source PDF index goes in source_image_index. Do NOT create new_buckets or new_lines from a sub quote.
4. For a PDF INVOICE/BILL (work done, money owed): emit a new_bills entry with vendor, vendor_gst_number (the vendor's GST/HST Business Number if printed — labeled "GST Reg #", "HST #", "BN", "Business Number", etc. Canadian format is 9 digits + "RT" + 4 digits like "123456789 RT0001", or just the 9-digit root. Null if not visible), bill_date (YYYY-MM-DD), amount_cents (pre-GST subtotal in integer cents), gst_cents (GST/HST portion in integer cents — extract from lines like "GST 5%", "HST 13%", "GST incl.", "GST INCLUDED", "GST/HST". If only a rate is shown and no dollar figure, compute cents from the subtotal and rate. Return 0 only when GST is definitely not charged), a one-line description, and budget_category_name (match to the most relevant existing bucket, or null). The source PDF index goes in source_image_index. Do NOT create cost lines for invoices.
5. For a RECEIPT (paid invoice / store receipt — image or PDF): emit a new_expenses entry with vendor, vendor_gst_number (same rule as bills — BN if printed, null otherwise), amount in integer cents, date (YYYY-MM-DD), and a one-line description. If the receipt clearly fits an existing or proposed bucket, set budget_category_name; otherwise leave null. Receipts are NOT cost-line estimates — they're real money already spent.
6. REFERENCE PHOTOS of existing conditions (rooms, fixtures, before/after) → attach to the most relevant cost line via source_image_indexes. They show what work is being done on.
7. SKETCHES with measurements, INSPIRATION shots, and PDF DOCS (drawings/specs/scope, NOT quotes or invoices) → emit a new_artifacts entry. These are project knowledge, not cost lines. Do NOT create a cost line for "Fireplace measurements" — make it a new_artifact with label ("Fireplace measurement sketch") and a 1–2 sentence summary. Pick the most accurate kind: 'sketch' | 'inspiration' | 'drawing'.
8. Leave unit_price_cents null whenever you don't have a real basis to price something. Do NOT guess prices (except where a PDF quote, invoice, or receipt states a real number).
9. Description addendum: only set if the artifact reveals scope/context that's not in the current description. Append, don't replace.
10. Signals: only set fields the artifact actually evidences. Don't restate prior signals.
11. Reply draft: only generate one if the artifacts include a conversation screenshot the operator should respond to. See VOICE rules below.
12. Tag each artifact's role and any relevant tags.

EVERY non-screenshot image must end up in EXACTLY ONE of: a new_line's source_image_indexes (reference photo), a new_bill's source_image_index (invoice), a new_expense's source_image_index (receipt), or a new_artifact's source_image_index (sketch / inspiration / drawing). NEVER invent a cost line just to hold a measurement sketch or invoice.

Return ONLY JSON matching the schema. Use empty arrays / null for anything you don't have. Never invent details.

${HUMAN_VOICE_RULES}`;

export const AUGMENT_JSON_SCHEMA = {
  name: 'project_intake_augment',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      description_addendum: { type: ['string', 'null'] },
      new_buckets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            section: { type: ['string', 'null'] },
          },
          required: ['name', 'section'],
        },
      },
      new_lines: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            budget_category_name: { type: 'string' },
            label: { type: 'string' },
            notes: { type: ['string', 'null'] },
            qty: { type: 'number' },
            unit: { type: 'string' },
            unit_price_cents: { type: ['integer', 'null'] },
            source_image_indexes: {
              type: 'array',
              items: { type: 'integer' },
            },
          },
          required: [
            'budget_category_name',
            'label',
            'notes',
            'qty',
            'unit',
            'unit_price_cents',
            'source_image_indexes',
          ],
        },
      },
      new_bills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vendor: { type: ['string', 'null'] },
            vendor_gst_number: { type: ['string', 'null'] }, // BN if printed on the invoice
            bill_date: { type: ['string', 'null'] }, // YYYY-MM-DD
            description: { type: ['string', 'null'] },
            amount_cents: { type: 'integer' }, // pre-GST subtotal
            gst_cents: { type: 'integer' }, // 0 if no GST
            budget_category_name: { type: ['string', 'null'] },
            source_image_index: { type: ['integer', 'null'] },
          },
          required: [
            'vendor',
            'vendor_gst_number',
            'bill_date',
            'description',
            'amount_cents',
            'gst_cents',
            'budget_category_name',
            'source_image_index',
          ],
        },
      },
      new_artifacts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['sketch', 'inspiration', 'drawing'] },
            label: { type: 'string' },
            summary: { type: ['string', 'null'] },
            source_image_index: { type: 'integer' },
          },
          required: ['kind', 'label', 'summary', 'source_image_index'],
        },
      },
      new_expenses: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vendor: { type: ['string', 'null'] },
            vendor_gst_number: { type: ['string', 'null'] }, // BN if printed on the receipt
            amount_cents: { type: 'integer' },
            expense_date: { type: ['string', 'null'] }, // YYYY-MM-DD
            description: { type: ['string', 'null'] },
            budget_category_name: { type: ['string', 'null'] },
            source_image_index: { type: ['integer', 'null'] },
          },
          required: [
            'vendor',
            'vendor_gst_number',
            'amount_cents',
            'expense_date',
            'description',
            'budget_category_name',
            'source_image_index',
          ],
        },
      },
      new_sub_quotes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            vendor_name: { type: 'string' },
            vendor_email: { type: ['string', 'null'] },
            vendor_phone: { type: ['string', 'null'] },
            total_cents: { type: 'integer' },
            scope_description: { type: ['string', 'null'] },
            quote_date: { type: ['string', 'null'] }, // YYYY-MM-DD
            valid_until: { type: ['string', 'null'] }, // YYYY-MM-DD
            line_items: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  label: { type: 'string' },
                  qty: { type: ['number', 'null'] },
                  unit_price_cents: { type: ['integer', 'null'] },
                  line_total_cents: { type: ['integer', 'null'] },
                },
                required: ['label', 'qty', 'unit_price_cents', 'line_total_cents'],
              },
            },
            allocations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  budget_category_name: { type: 'string' },
                  allocated_cents: { type: 'integer' },
                  reasoning: { type: 'string' },
                },
                required: ['budget_category_name', 'allocated_cents', 'reasoning'],
              },
            },
            source_image_index: { type: ['integer', 'null'] },
          },
          required: [
            'vendor_name',
            'vendor_email',
            'vendor_phone',
            'total_cents',
            'scope_description',
            'quote_date',
            'valid_until',
            'line_items',
            'allocations',
            'source_image_index',
          ],
        },
      },
      signals: {
        type: 'object',
        additionalProperties: false,
        properties: {
          competitive: { type: ['boolean', 'null'] },
          competitor_count: { type: ['integer', 'null'] },
          urgency: { type: ['string', 'null'], enum: ['low', 'normal', 'high', null] },
          upsells: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string' },
                reason: { type: 'string' },
              },
              required: ['label', 'reason'],
            },
          },
          design_intent: { type: 'array', items: { type: 'string' } },
        },
        required: ['competitive', 'competitor_count', 'urgency', 'upsells', 'design_intent'],
      },
      reply_draft: { type: ['string', 'null'] },
      image_roles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' },
            role: {
              type: 'string',
              enum: [
                'conversation_screenshot',
                'reference_photo',
                'sketch_with_measurements',
                'inspiration',
                'pdf_quote',
                'pdf_invoice',
                'pdf_doc',
                'receipt',
                'other',
              ],
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['index', 'role', 'tags'],
        },
      },
    },
    required: [
      'description_addendum',
      'new_buckets',
      'new_lines',
      'new_bills',
      'new_artifacts',
      'new_expenses',
      'new_sub_quotes',
      'signals',
      'reply_draft',
      'image_roles',
    ],
  },
} as const;

export type AugmentSignals = {
  competitive: boolean | null;
  competitor_count: number | null;
  urgency: 'low' | 'normal' | 'high' | null;
  upsells: Array<{ label: string; reason: string }>;
  design_intent: string[];
};

export type AugmentExpense = {
  vendor: string | null;
  vendor_gst_number: string | null;
  amount_cents: number;
  expense_date: string | null;
  description: string | null;
  budget_category_name: string | null;
  source_image_index: number | null;
};

export type AugmentBill = {
  vendor: string | null;
  vendor_gst_number: string | null;
  bill_date: string | null;
  description: string | null;
  amount_cents: number;
  gst_cents: number;
  budget_category_name: string | null;
  source_image_index: number | null;
};

export type AugmentArtifact = {
  kind: 'sketch' | 'inspiration' | 'drawing';
  label: string;
  summary: string | null;
  source_image_index: number;
};

export type AugmentSubQuote = {
  vendor_name: string;
  vendor_email: string | null;
  vendor_phone: string | null;
  total_cents: number;
  scope_description: string | null;
  quote_date: string | null;
  valid_until: string | null;
  line_items: Array<{
    label: string;
    qty: number | null;
    unit_price_cents: number | null;
    line_total_cents: number | null;
  }>;
  allocations: Array<{
    budget_category_name: string;
    allocated_cents: number;
    reasoning: string;
  }>;
  source_image_index: number | null;
};

export type AugmentResult = {
  description_addendum: string | null;
  new_buckets: Array<{ name: string; section: string | null }>;
  new_lines: Array<{
    budget_category_name: string;
    label: string;
    notes: string | null;
    qty: number;
    unit: string;
    unit_price_cents: number | null;
    source_image_indexes: number[];
  }>;
  new_bills: AugmentBill[];
  new_artifacts: AugmentArtifact[];
  new_expenses: AugmentExpense[];
  new_sub_quotes: AugmentSubQuote[];
  signals: AugmentSignals;
  reply_draft: string | null;
  image_roles: Array<{
    index: number;
    role:
      | 'conversation_screenshot'
      | 'reference_photo'
      | 'sketch_with_measurements'
      | 'inspiration'
      | 'pdf_quote'
      | 'pdf_invoice'
      | 'pdf_doc'
      | 'receipt'
      | 'other';
    tags: string[];
  }>;
};
