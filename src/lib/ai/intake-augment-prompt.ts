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
- One or more new artifacts (images and/or PDFs — sub-trade quotes, drawings, specs)

Your job: return a list of additions and updates the operator can review.

Rules:
1. Reuse existing bucket names whenever the artifact's content fits one. Only propose a NEW bucket when nothing existing fits.
2. When proposing a new line, name the target bucket EXACTLY as it appears in the existing project, or use a new bucket name you also propose.
3. For a PDF quote from a sub-trade: create a new bucket named after the trade (e.g. "Plumbing — Sub") or the company name, and add line items from the quote. Capture the prices stated in the quote (unit_price_cents in integer cents).
4. For a RECEIPT (paid invoice / store receipt — image or PDF): emit a new_expenses entry with vendor, amount in integer cents, date (YYYY-MM-DD), and a one-line description. If the receipt clearly fits an existing or proposed bucket, set bucket_name; otherwise leave null. Receipts are NOT cost-line estimates — they're real money already spent.
5. REFERENCE PHOTOS of existing conditions (rooms, fixtures, before/after) → attach to the most relevant cost line via source_image_indexes. They show what work is being done on.
6. SKETCHES with measurements, INSPIRATION shots, and PDF DOCS (drawings/specs/scope, NOT quotes) → emit a new_artifacts entry. These are project knowledge, not cost lines. Do NOT create a cost line for "Fireplace measurements" — make it a new_artifact with label ("Fireplace measurement sketch") and a 1–2 sentence summary. Pick the most accurate kind: 'sketch' | 'inspiration' | 'drawing'.
7. Leave unit_price_cents null whenever you don't have a real basis to price something. Do NOT guess prices (except where a PDF quote or receipt states a real number).
8. Description addendum: only set if the artifact reveals scope/context that's not in the current description. Append, don't replace.
9. Signals: only set fields the artifact actually evidences. Don't restate prior signals.
10. Reply draft: only generate one if the artifacts include a conversation screenshot the operator should respond to. See VOICE rules below.
11. Tag each artifact's role and any relevant tags.

EVERY non-screenshot image must end up in EXACTLY ONE of: a new_line's source_image_indexes (reference photo), a new_expense's source_image_index (receipt), or a new_artifact's source_image_index (sketch / inspiration / drawing). NEVER invent a cost line just to hold a measurement sketch.

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
            bucket_name: { type: 'string' },
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
            'bucket_name',
            'label',
            'notes',
            'qty',
            'unit',
            'unit_price_cents',
            'source_image_indexes',
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
            amount_cents: { type: 'integer' },
            expense_date: { type: ['string', 'null'] }, // YYYY-MM-DD
            description: { type: ['string', 'null'] },
            bucket_name: { type: ['string', 'null'] },
            source_image_index: { type: ['integer', 'null'] },
          },
          required: [
            'vendor',
            'amount_cents',
            'expense_date',
            'description',
            'bucket_name',
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
      'new_artifacts',
      'new_expenses',
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
  amount_cents: number;
  expense_date: string | null;
  description: string | null;
  bucket_name: string | null;
  source_image_index: number | null;
};

export type AugmentArtifact = {
  kind: 'sketch' | 'inspiration' | 'drawing';
  label: string;
  summary: string | null;
  source_image_index: number;
};

export type AugmentResult = {
  description_addendum: string | null;
  new_buckets: Array<{ name: string; section: string | null }>;
  new_lines: Array<{
    bucket_name: string;
    label: string;
    notes: string | null;
    qty: number;
    unit: string;
    unit_price_cents: number | null;
    source_image_indexes: number[];
  }>;
  new_artifacts: AugmentArtifact[];
  new_expenses: AugmentExpense[];
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
      | 'pdf_doc'
      | 'receipt'
      | 'other';
    tags: string[];
  }>;
};
