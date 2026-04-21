'use server';

/**
 * OCR + structured extraction for receipt uploads.
 *
 * Worker (and owner) expense forms drop a receipt image/PDF; we run it
 * through OpenAI's vision model to pre-fill amount / vendor / date /
 * description. The user reviews and can correct before submitting — we
 * never silently overwrite values they've already typed.
 *
 * Guiding principle: if the user is already uploading the file, don't
 * make them type what the file already tells us.
 */

import { requireWorker } from '@/lib/auth/helpers';

const MAX_BYTES = 10 * 1024 * 1024;
const EXTRACT_MODEL = 'gpt-4o-mini';

export type ReceiptExtractionResult =
  | {
      ok: true;
      fields: {
        amountCents: number | null;
        vendor: string | null;
        expenseDate: string | null; // YYYY-MM-DD
        description: string | null;
      };
    }
  | { ok: false; error: string };

export async function extractReceiptFieldsAction(
  formData: FormData,
): Promise<ReceiptExtractionResult> {
  // Auth: any worker (or owner) with a tenant can extract. The extraction
  // doesn't touch the DB, so we only gate on auth, not role.
  await requireWorker();

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };

  const file = formData.get('receipt');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No receipt uploaded.' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: 'Receipt is larger than 10MB.' };
  }

  const mime = file.type || 'image/jpeg';
  // PDFs are not directly supported by chat.completions image input — we
  // could render to PNG server-side, but keep scope tight for now.
  if (!mime.startsWith('image/')) {
    return {
      ok: true,
      fields: { amountCents: null, vendor: null, expenseDate: null, description: null },
    };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;

  const body = {
    model: EXTRACT_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You extract structured fields from receipt photos. Return ONLY JSON matching the schema. Use null for anything you cannot read with confidence. Dates must be YYYY-MM-DD. Amounts must be the receipt total in cents (integer). Vendor is the merchant name as shown. Description is a 1-line summary of what was purchased (e.g., "lumber and fasteners" or "lunch for crew"); omit if not clear.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Extract the fields from this receipt.' },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'receipt_fields',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            amount_cents: { type: ['integer', 'null'] },
            vendor: { type: ['string', 'null'] },
            expense_date: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
          },
          required: ['amount_cents', 'vendor', 'expense_date', 'description'],
        },
      },
    },
  };

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }

  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'OpenAI returned no content.' };

  let parsed: {
    amount_cents: number | null;
    vendor: string | null;
    expense_date: string | null;
    description: string | null;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  return {
    ok: true,
    fields: {
      amountCents: parsed.amount_cents,
      vendor: parsed.vendor?.trim() || null,
      expenseDate: parsed.expense_date,
      description: parsed.description?.trim() || null,
    },
  };
}
