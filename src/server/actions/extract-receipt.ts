'use server';

/**
 * OCR + structured extraction for receipt uploads.
 *
 * Worker (and owner) expense forms drop a receipt image/PDF; we run it
 * through Gemini's vision model to pre-fill amount / vendor / date /
 * description. The user reviews and can correct before submitting — we
 * never silently overwrite values they've already typed.
 *
 * Guiding principle: if the user is already uploading the file, don't
 * make them type what the file already tells us.
 *
 * Provider: Gemini 2.5 Flash via @google/genai. Originally OpenAI; moved
 * after a quota cliff blocked extraction in production for the only paying
 * tenant. Gemini has no per-org hard quota at our volume and we already
 * use it for invoice payment-receipt OCR (see actions/invoices.ts).
 */

import { GoogleGenAI } from '@google/genai';
import { requireTenant } from '@/lib/auth/helpers';

const MAX_BYTES = 10 * 1024 * 1024;
const MODEL = 'gemini-2.5-flash';

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

const PROMPT = `You extract structured fields from receipt photos or PDFs for a Canadian contractor. Return ONLY JSON matching this exact shape — no prose, no markdown fences. Use null for any field you cannot read with confidence.

{
  "amount_cents": INTEGER cents — receipt grand total, tax INCLUDED. e.g. $18.40 → 1840.
  "vendor": merchant name as shown.
  "vendor_gst_number": the vendor's GST/HST business number if printed. Canadian format is 9 digits + "RT" + 4 digits (e.g. "123456789 RT0001"). Commonly labeled "GST Reg #", "HST #", "BN", "Business Number", or near the vendor's address. If only the 9-digit root is shown, return those 9 digits. null if not visible.
  "expense_date": "YYYY-MM-DD" — transaction date, not print time.
  "description": one short line describing what was purchased (e.g. "lumber and fasteners", "lunch for crew"). null if unclear.
}

Note: Canadian receipts commonly show GST/HST as "GST 5%", "HST 13%", "GST incl.", "GST INCLUDED", or "GST/HST". The amount_cents field is always the receipt total with tax included.`;

/**
 * Strip provider error verbosity (HTTP bodies, "OpenAI 429: { ... }",
 * stack traces) and return a user-safe message. Never expose raw JSON to
 * the toast layer.
 */
function userSafeError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  if (/quota|insufficient_quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return 'Receipt scanning is temporarily unavailable. Please fill the form manually.';
  }
  if (/503|UNAVAILABLE|overload/i.test(msg)) {
    return 'Receipt scanning is busy right now. Please try again in a moment.';
  }
  if (/timeout|ETIMEDOUT/i.test(msg)) {
    return 'Receipt scanning timed out. Please try again or fill the form manually.';
  }
  // Safe generic — never leak provider response bodies.
  return 'Could not read receipt. Please fill the form manually.';
}

export async function extractReceiptFieldsAction(
  formData: FormData,
): Promise<ReceiptExtractionResult> {
  // Auth: any worker, owner, or admin with a tenant can extract. The
  // extraction doesn't touch the DB, so we only gate on tenancy, not role.
  await requireTenant();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'Receipt scanning is not configured on this server.' };
  }

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
  const base64 = buf.toString('base64');

  const ai = new GoogleGenAI({ apiKey });
  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
  let lastErr: unknown = null;

  // Retry only on transient overload (503/UNAVAILABLE). Quota and bad
  // requests fail fast — retrying won't help.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: 'user',
            parts: [{ text: PROMPT }, { inlineData: { mimeType: mime, data: base64 } }],
          },
        ],
        config: { responseMimeType: 'application/json', temperature: 0.1 },
      });
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /503|UNAVAILABLE|overload/i.test(msg);
      if (!transient) {
        return { ok: false, error: userSafeError(err) };
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1) ** 2));
    }
  }

  if (!response) {
    return { ok: false, error: userSafeError(lastErr) };
  }

  const content = response.text ?? '';
  if (!content) {
    return { ok: false, error: 'Could not read receipt. Please fill the form manually.' };
  }

  let parsed: {
    amount_cents: unknown;
    vendor: unknown;
    vendor_gst_number: unknown;
    expense_date: unknown;
    description: unknown;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'Could not read receipt. Please fill the form manually.' };
  }

  const amountCents =
    typeof parsed.amount_cents === 'number' && Number.isFinite(parsed.amount_cents)
      ? Math.round(parsed.amount_cents)
      : null;
  const vendor =
    typeof parsed.vendor === 'string' && parsed.vendor.trim() ? parsed.vendor.trim() : null;
  const vendorGstNumber =
    typeof parsed.vendor_gst_number === 'string' && parsed.vendor_gst_number.trim()
      ? parsed.vendor_gst_number.trim()
      : null;
  const expenseDate =
    typeof parsed.expense_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.expense_date)
      ? parsed.expense_date
      : null;
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim()
      : null;

  return {
    ok: true,
    fields: {
      amountCents,
      vendor,
      vendorGstNumber,
      expenseDate,
      description,
    },
  };
}
