'use server';

/**
 * Parse a renovation quote PDF with Gemini and return a structured
 * extraction the operator can review before creating a project.
 *
 * No DB writes happen here — commit is a separate action.
 */

import { GoogleGenAI } from '@google/genai';

export type QuoteExtractionBucket = {
  section: string;
  name: string;
  description: string;
  estimate_cents: number;
  display_order: number;
};

export type QuoteExtraction = {
  customer: {
    name: string;
    address: string | null;
  };
  project: {
    name: string;
    quote_date: string | null;
    management_fee_rate: number | null;
    subtotal_cents: number | null;
    tax_cents: number | null;
    total_cents: number | null;
  };
  buckets: QuoteExtractionBucket[];
  uncertainty_flags: string[];
};

export type ParseQuoteResult =
  | { ok: true; extraction: QuoteExtraction }
  | { ok: false; error: string };

const PROMPT = `You are extracting a renovation contractor's quote into structured JSON so an operator can review it and create a project.

Rules:
- Preserve task/section names EXACTLY as written on the quote. Do not normalize "UPSTAIRS WORK" to "upstairs", do not rename "Vanity" to "Bathroom Fixtures". The contractor's words win.
- Every distinct line item becomes one bucket. A section header (like "UPSTAIRS WORK", "DOWNSTAIRS", "EXTERIOR") is the bucket's "section" string.
- "name" is the short label for the line item. "description" is any additional detail on that line — sub-bullets, scope notes, inclusions/exclusions, materials called out, quantities, comments. Preserve the contractor's wording. If a line has no extra detail, use an empty string. Do NOT duplicate the name into the description.
- "estimate_cents" is the line's dollar amount × 100, integer.
- "management_fee_rate" is a decimal (15% → 0.15). Null if not stated.
- "quote_date" is ISO (YYYY-MM-DD). If only a month is given (e.g. "April 2026"), use the 1st of that month.
- Subtotal, tax, and total are the quote's totals — capture them so the operator can sanity-check. Do NOT emit them as buckets.
- "uncertainty_flags" is a list of short strings for anything ambiguous (illegible amounts, unclear task boundaries, multiple customers, etc). Empty array if clean.
- Customer name is the full string as shown (e.g. "Graham, Heather & Aaron Brandscombe"). Address is the site address, not the contractor's address.

Respond with ONLY valid JSON in this exact shape:
{
  "customer": { "name": "string", "address": "string or null" },
  "project": {
    "name": "string",
    "quote_date": "YYYY-MM-DD or null",
    "management_fee_rate": 0.15,
    "subtotal_cents": 0,
    "tax_cents": 0,
    "total_cents": 0
  },
  "buckets": [
    { "section": "string", "name": "string", "description": "string", "estimate_cents": 0, "display_order": 0 }
  ],
  "uncertainty_flags": []
}`;

export async function parseQuotePdfAction(formData: FormData): Promise<ParseQuoteResult> {
  const file = formData.get('file');
  if (!(file instanceof File)) {
    return { ok: false, error: 'No file uploaded.' };
  }
  if (file.type !== 'application/pdf') {
    return { ok: false, error: `Expected PDF, got ${file.type || 'unknown'}.` };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, error: 'GEMINI_API_KEY not configured.' };

  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString('base64');
  const ai = new GoogleGenAI({ apiKey });

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  const delays = [0, 2000, 5000];

  let text = '';
  let lastErr: unknown = null;
  for (let i = 0; i < models.length; i++) {
    if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
    try {
      const response = await ai.models.generateContent({
        model: models[i],
        contents: [
          {
            role: 'user',
            parts: [
              { text: PROMPT },
              { inlineData: { mimeType: 'application/pdf', data: base64 } },
            ],
          },
        ],
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      });
      text = response.text ?? '';
      if (text) {
        lastErr = null;
        break;
      }
      lastErr = new Error('Empty response from Gemini.');
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/\b(503|429|overload|unavailable|rate)/i.test(msg)) {
        return { ok: false, error: `Gemini error: ${msg}` };
      }
    }
  }

  if (!text) {
    return {
      ok: false,
      error: `Gemini overloaded after retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    };
  }

  let extraction: QuoteExtraction;
  try {
    extraction = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (!match) return { ok: false, error: 'Failed to parse AI response as JSON.' };
    try {
      extraction = JSON.parse(match[1]);
    } catch {
      return { ok: false, error: 'Failed to parse AI response as JSON.' };
    }
  }

  return { ok: true, extraction };
}
