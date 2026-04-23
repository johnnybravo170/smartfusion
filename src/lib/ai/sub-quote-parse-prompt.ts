/**
 * Prompt + response schema for parsing an uploaded sub-quote document.
 *
 * Inputs the model sees:
 *   - The project's existing bucket roster (name + section)
 *   - One PDF or image (the incoming sub/vendor quote)
 *
 * What it returns:
 *   - Whether the document actually looks like a sub quote
 *   - Extracted header fields (vendor, total, scope, dates)
 *   - Line items if structured
 *   - Allocation suggestions mapped to EXISTING bucket names only
 *
 * When the model can't confidently map scope to buckets, allocations is
 * empty — the operator fills it in. Per the sub-quotes plan we never
 * pre-fill a guess, because wrong guesses erode trust.
 */

export const SUB_QUOTE_PARSE_SYSTEM_PROMPT = `You are Henry, a document-parsing assistant for a general contractor. You receive a single document (PDF or image) that should be a quote or estimate from a subcontractor or supplier. You extract structured fields and suggest how the quote's dollars could be split across the project's existing cost buckets.

Rules:
1. First decide: is this actually a sub/vendor quote? If it's an invoice, bill, receipt, photo without pricing, or something unrelated, set doc_type to "not_sub_quote" and explain in reason_if_not. Do not fabricate values.
2. Extract fields you can see on the document. Use null for anything that's not present. Never guess the vendor or total.
3. Dates must be ISO YYYY-MM-DD. If the document shows a less-precise date ("April 2026"), leave it null.
4. Dollar amounts are stored as integer cents. $18,500.00 = 1850000.
5. For allocations:
   - bucket_name MUST be an EXACT match to one of the existing bucket names provided. Do not invent bucket names. Do not case-shift.
   - If the scope text does not clearly match any existing bucket, leave allocations empty. Do not pre-fill a guess — operators strongly prefer to allocate manually rather than correct a wrong AI guess.
   - Sum of allocated_cents across all allocations should equal the extracted total_cents. If your confidence in allocating is uneven, only include the allocations you're confident in and let the operator fill in the rest.
   - Mark each allocation's confidence honestly: "high" (scope literally names the bucket), "medium" (scope thematically matches the bucket), "low" (don't include — leave for operator).
6. Be terse. Scope descriptions should be the vendor's own words where possible, not your rewording.`;

export const SUB_QUOTE_PARSE_JSON_SCHEMA = {
  name: 'sub_quote_parse',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      doc_type: {
        type: 'string',
        enum: ['sub_quote', 'not_sub_quote'],
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
      },
      reason_if_not: { type: ['string', 'null'] },
      extracted: {
        type: 'object',
        additionalProperties: false,
        properties: {
          vendor_name: { type: ['string', 'null'] },
          vendor_email: { type: ['string', 'null'] },
          vendor_phone: { type: ['string', 'null'] },
          total_cents: { type: ['integer', 'null'] },
          scope_description: { type: ['string', 'null'] },
          quote_date: { type: ['string', 'null'] },
          valid_until: { type: ['string', 'null'] },
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
        ],
      },
      allocations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            bucket_name: { type: 'string' },
            allocated_cents: { type: 'integer' },
            confidence: {
              type: 'string',
              enum: ['high', 'medium', 'low'],
            },
            reasoning: { type: 'string' },
          },
          required: ['bucket_name', 'allocated_cents', 'confidence', 'reasoning'],
        },
      },
    },
    required: ['doc_type', 'confidence', 'reason_if_not', 'extracted', 'allocations'],
  },
} as const;

export type SubQuoteParseResult = {
  doc_type: 'sub_quote' | 'not_sub_quote';
  confidence: 'high' | 'medium' | 'low';
  reason_if_not: string | null;
  extracted: {
    vendor_name: string | null;
    vendor_email: string | null;
    vendor_phone: string | null;
    total_cents: number | null;
    scope_description: string | null;
    quote_date: string | null;
    valid_until: string | null;
    line_items: Array<{
      label: string;
      qty: number | null;
      unit_price_cents: number | null;
      line_total_cents: number | null;
    }>;
  };
  allocations: Array<{
    bucket_name: string;
    allocated_cents: number;
    confidence: 'high' | 'medium' | 'low';
    reasoning: string;
  }>;
};
