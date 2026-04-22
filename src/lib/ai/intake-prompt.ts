/**
 * Prompt + JSON schema for the inbound-lead intake parser.
 *
 * Inputs: a customer name, optional pasted text, and 1+ images that
 * mix conversation screenshots with reference photos. Output: a
 * draft estimate (buckets + lines), captured signals, and a reply
 * the contractor can send back in their own voice.
 */

export const INTAKE_SYSTEM_PROMPT = `You are an intake specialist for a Canadian general contractor.

You receive screenshots of a text/iMessage thread between the contractor and a prospective client, plus reference photos the client sent (existing conditions, hand-drawn measurements, inspiration shots). Your job:

1. Read the conversation. Extract scope, opt-outs ("baseboards OK as-is"), design intent ("chunky brick"), and competitive signals ("getting other quotes").
2. Tell screenshots apart from reference photos. Screenshots are flat UI captures with chat bubbles; reference photos are real-world (rooms, fireplaces, sketches).
3. Draft a starting estimate. Group cost lines into buckets that match the contractor's mental model (Floors, Fireplace, Demo, etc). Use the bucket section field for higher-level grouping if obvious (e.g. "Upstairs Work" / "Downstairs"); otherwise leave section null.
4. Leave unit_price_cents NULL whenever you don't have a real basis to price something. Do NOT guess prices.
5. Draft a short reply in the contractor's voice — friendly, direct, Canadian, no emoji unless the client used them. Answer their questions, address opt-outs, propose next step. Two short paragraphs max.
6. Tag image roles so the contractor knows which is which.

Return ONLY JSON matching the schema. Use empty arrays / null for anything you cannot confidently extract. Never invent details that aren't in the message or photos.`;

export const INTAKE_JSON_SCHEMA = {
  name: 'inbound_lead_intake',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      customer: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          address: { type: ['string', 'null'] },
        },
        required: ['name', 'phone', 'email', 'address'],
      },
      project: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
        },
        required: ['name', 'description'],
      },
      buckets: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            section: { type: ['string', 'null'] },
            lines: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
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
                  'label',
                  'notes',
                  'qty',
                  'unit',
                  'unit_price_cents',
                  'source_image_indexes',
                ],
              },
            },
          },
          required: ['name', 'section', 'lines'],
        },
      },
      signals: {
        type: 'object',
        additionalProperties: false,
        properties: {
          competitive: { type: 'boolean' },
          competitor_count: { type: ['integer', 'null'] },
          urgency: { type: 'string', enum: ['low', 'normal', 'high'] },
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
      reply_draft: { type: 'string' },
      image_roles: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer' },
            role: {
              type: 'string',
              enum: ['screenshot', 'reference', 'measurement', 'other'],
            },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['index', 'role', 'tags'],
        },
      },
    },
    required: ['customer', 'project', 'buckets', 'signals', 'reply_draft', 'image_roles'],
  },
} as const;

export type ParsedIntake = {
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  };
  project: { name: string; description: string | null };
  buckets: Array<{
    name: string;
    section: string | null;
    lines: Array<{
      label: string;
      notes: string | null;
      qty: number;
      unit: string;
      unit_price_cents: number | null;
      source_image_indexes: number[];
    }>;
  }>;
  signals: {
    competitive: boolean;
    competitor_count: number | null;
    urgency: 'low' | 'normal' | 'high';
    upsells: Array<{ label: string; reason: string }>;
    design_intent: string[];
  };
  reply_draft: string;
  image_roles: Array<{
    index: number;
    role: 'screenshot' | 'reference' | 'measurement' | 'other';
    tags: string[];
  }>;
};
