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

import { requireTenant } from '@/lib/auth/helpers';

const MAX_BYTES = 10 * 1024 * 1024;
const EXTRACT_MODEL = 'gpt-4o-mini';

export type ReceiptExtractionResult =
  | {
      ok: true;
      fields: {
        amountCents: number | null;
        vendor: string | null;
        /** Vendor GST/HST business number if printed on the receipt. */
        vendorGstNumber: string | null;
        expenseDate: string | null; // YYYY-MM-DD
        description: string | null;
      };
    }
  | { ok: false; error: string };

export async function extractReceiptFieldsAction(
  formData: FormData,
): Promise<ReceiptExtractionResult> {
  // Auth: any worker, owner, or admin with a tenant can extract. The
  // extraction doesn't touch the DB, so we only gate on tenancy, not role.
  // Owner-side caller is the global QuickLogExpenseButton in the dashboard
  // header — using requireWorker() here redirected owners to /dashboard
  // mid-action and the client surfaced "Could not read receipt".
  await requireTenant();

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
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mime}` };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const b64 = buf.toString('base64');

  // Chat Completions accepts PDFs directly via the `file` content block
  // (base64 inline, up to 32MB). Images use the `image_url` block. Both
  // paths go through gpt-4o-mini.
  const userContent: Array<Record<string, unknown>> = [
    { type: 'text', text: 'Extract the fields from this receipt.' },
  ];
  if (isPdf) {
    userContent.push({
      type: 'file',
      file: {
        filename: file.name || 'receipt.pdf',
        file_data: `data:application/pdf;base64,${b64}`,
      },
    });
  } else {
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    });
  }

  const body = {
    model: EXTRACT_MODEL,
    messages: [
      {
        role: 'system',
        content: `You extract structured fields from receipt photos or PDFs for a Canadian contractor. Return ONLY JSON matching the schema. Use null for anything you cannot read with confidence.

- expense_date: YYYY-MM-DD. Transaction date, not print time.
- amount_cents: INTEGER cents. The receipt grand total (tax included).
- vendor: merchant name as shown.
- vendor_gst_number: the vendor's GST/HST business number (BN) if printed on the receipt. Canadian format is 9 digits + "RT" + 4 digits (e.g. "123456789 RT0001" or "123456789RT0001"). Commonly labeled "GST Reg #", "HST #", "BN", "Business Number", or near the vendor's address. If only the 9-digit root is shown, return those 9 digits. Return null if not visible.
- description: 1-line summary of what was purchased (e.g. "lumber and fasteners", "lunch for crew"). Null if unclear.

Note: Canadian receipts commonly show GST/HST as "GST 5%", "HST 13%", "GST incl.", "GST INCLUDED", or "GST/HST". The amount_cents field is always the receipt total with tax in it.`,
      },
      { role: 'user', content: userContent },
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
            vendor_gst_number: { type: ['string', 'null'] },
            expense_date: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
          },
          required: ['amount_cents', 'vendor', 'vendor_gst_number', 'expense_date', 'description'],
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
    vendor_gst_number: string | null;
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
      vendorGstNumber: parsed.vendor_gst_number?.trim() || null,
      expenseDate: parsed.expense_date,
      description: parsed.description?.trim() || null,
    },
  };
}
