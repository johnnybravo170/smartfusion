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
4. Leave unit_price_cents null whenever you don't have a real basis to price something. Do NOT guess prices (except where a PDF quote states a real number).
4. Description addendum: only set if the artifact reveals scope/context that's not in the current description. Append, don't replace.
5. Signals: only set fields the artifact actually evidences. Don't restate prior signals.
6. Reply draft: only generate one if the artifacts include a conversation screenshot the operator should respond to. See VOICE rules below.
7. Tag each artifact's role and any relevant tags.

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
      | 'other';
    tags: string[];
  }>;
};
