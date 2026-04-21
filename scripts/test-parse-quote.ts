#!/usr/bin/env tsx
/**
 * Smoke test: run the quote PDF extraction against a sample PDF and print
 * the JSON. Uses GEMINI_API_KEY from .env.local.
 *
 * Usage: tsx scripts/test-parse-quote.ts <path/to/quote.pdf>
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

// tsx auto-loads .env.local — no dotenv needed.

const PROMPT = `You are extracting a renovation contractor's quote into structured JSON so an operator can review it and create a project.

Rules:
- Preserve task/section names EXACTLY as written on the quote. Do not normalize "UPSTAIRS WORK" to "upstairs", do not rename "Vanity" to "Bathroom Fixtures". The contractor's words win.
- Every distinct line item becomes one bucket. A section header (like "UPSTAIRS WORK", "DOWNSTAIRS", "EXTERIOR") is the bucket's "section" string.
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

async function main() {
  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('Usage: tsx scripts/test-parse-quote.ts <path/to/quote.pdf>');
    process.exit(1);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY missing in .env.local');
    process.exit(1);
  }

  const base64 = readFileSync(pdfPath).toString('base64');
  const ai = new GoogleGenAI({ apiKey });

  const models = ['gemini-2.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  const delays = [0, 3000, 6000];
  let text: string | undefined;
  let lastErr: unknown = null;
  for (let i = 0; i < models.length; i++) {
    if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]));
    console.error(`→ Calling ${models[i]} (attempt ${i + 1})...`);
    const t0 = Date.now();
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
      console.error(`← ${Date.now() - t0}ms`);
      text = response.text;
      if (text) break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${msg.slice(0, 200)}`);
      if (!/\b(503|429|overload|unavailable|rate)/i.test(msg)) throw err;
    }
  }
  if (!text) throw lastErr ?? new Error('no text');
  console.log(text);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
