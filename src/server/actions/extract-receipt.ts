'use server';

/**
 * OCR + structured extraction for receipt uploads.
 *
 * Worker (and owner) expense forms drop a receipt image/PDF; we run it
 * through the AI gateway for vision + structured extraction. The user
 * reviews and can correct before submitting — we never silently overwrite
 * values they've already typed.
 *
 * Guiding principle: if the user is already uploading the file, don't
 * make them type what the file already tells us.
 *
 * Routing: see `routing.ts → receipt_ocr`. Gemini primary, 30% OpenAI
 * tier-climb traffic, fallback chain ['gemini', 'openai', 'anthropic'].
 * The original direct-Gemini code with hand-rolled retry / quota
 * fallback was migrated to the gateway in AG-7.
 */

import { gateway, isAiError } from '@/lib/ai-gateway';
import { requireTenant } from '@/lib/auth/helpers';

const MAX_BYTES = 10 * 1024 * 1024;

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

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    amount_cents: { type: ['integer', 'null'] },
    vendor: { type: ['string', 'null'] },
    vendor_gst_number: { type: ['string', 'null'] },
    expense_date: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
  },
  required: ['amount_cents', 'vendor', 'vendor_gst_number', 'expense_date', 'description'],
};

type RawReceipt = {
  amount_cents: unknown;
  vendor: unknown;
  vendor_gst_number: unknown;
  expense_date: unknown;
  description: unknown;
};

/**
 * Translate gateway errors to user-safe messages. Never leaks provider
 * response bodies. Now that the gateway falls through to the next
 * provider on quota / overload, the user-facing error appears only when
 * EVERY provider has failed — much rarer than before.
 */
function userSafeError(err: unknown): string {
  if (isAiError(err)) {
    if (err.kind === 'quota') {
      return 'Receipt scanning is temporarily unavailable across all providers. Please fill the form manually.';
    }
    if (err.kind === 'overload' || err.kind === 'rate_limit') {
      return 'Receipt scanning is busy right now. Please try again in a moment.';
    }
    if (err.kind === 'timeout') {
      return 'Receipt scanning timed out. Please try again or fill the form manually.';
    }
  }
  return 'Could not read receipt. Please fill the form manually.';
}

export async function extractReceiptFieldsAction(
  formData: FormData,
): Promise<ReceiptExtractionResult> {
  // Auth: any worker, owner, or admin with a tenant can extract. The
  // extraction doesn't touch the DB, so we only gate on tenancy, not role.
  const { tenant } = await requireTenant();

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

  let parsed: RawReceipt;
  try {
    const res = await gateway().runStructured<RawReceipt>({
      kind: 'structured',
      task: 'receipt_ocr',
      tenant_id: tenant.id,
      prompt: PROMPT,
      schema: RECEIPT_SCHEMA,
      file: { mime, base64, filename: file.name },
      temperature: 0.1,
    });
    parsed = res.data;
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
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
