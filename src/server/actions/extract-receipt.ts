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
import {
  extractCardLast4,
  listPaymentSources,
  normalizePaymentNetwork,
  type PaymentSourceLite,
  type PaymentSourceNetwork,
  type PaymentSourceResolution,
  resolvePaymentSource,
  toLite,
} from '@/lib/db/queries/payment-sources';

const MAX_BYTES = 10 * 1024 * 1024;

/** Category the caller wants Henry to choose from. The caller decides
 *  what list is appropriate (project budget categories vs tenant chart-
 *  of-accounts). Server validates the model's returned id against this
 *  list — anything off-list drops to null silently. */
export type ReceiptCategoryOption = { id: string; label: string };

export type ReceiptExtractionResult =
  | {
      ok: true;
      fields: {
        amountCents: number | null;
        /**
         * Receipt subtotal before GST/HST/PST. Used as the markup base on
         * cost-plus client invoices — the contractor reclaims the tax as
         * an ITC, so the *real* cost is pre-tax. Null when the receipt
         * doesn't show a tax breakdown or pre_tax + tax doesn't reconcile
         * to the total within 1¢; the cost-plus path falls back to
         * `amountCents` in that case.
         */
        preTaxAmountCents: number | null;
        /** GST/HST/PST charged on the receipt. Null when no breakdown. */
        taxAmountCents: number | null;
        vendor: string | null;
        /** Vendor GST/HST business number if printed on the receipt. */
        vendorGstNumber: string | null;
        expenseDate: string | null; // YYYY-MM-DD
        description: string | null;
        /** Suggested category id from the caller-supplied options. Null
         *  when no options were passed, no confident match, or the model
         *  returned an id not in the option set. */
        categoryId: string | null;
        /** Pre-resolved label so the caller doesn't have to look it up. */
        categoryLabel: string | null;
        /** Last 4 of the card the receipt was paid with, if visible. */
        cardLast4: string | null;
        /** Card network if printed alongside the last 4. */
        cardNetwork: PaymentSourceNetwork | null;
        /** Pre-resolved payment source — matched_card → a labeled card
         *  whose last4 matches; unknown_card → last4 was read but no
         *  source matches (caller surfaces "Label this card?"); fall-
         *  back_default → no card visible, tenant default returned. */
        paymentSourceId: string | null;
        paymentSourceResolution: PaymentSourceResolution;
        /** Tenant catalog of payment sources, so the caller can render
         *  the picker without an extra round-trip. Pre-sorted with the
         *  default first. */
        paymentSources: PaymentSourceLite[];
      };
    }
  | { ok: false; error: string };

function buildPrompt(categoryLines: string | null): string {
  const categoryField = categoryLines
    ? `  "category_id": pick the BEST matching category id from the list below. Match on the kind of purchase (lumber → "Materials"; gas → "Vehicle: Fuel"; restaurant → "Meals"; etc.). Return the id verbatim from the list. If nothing fits or you genuinely can't tell, return null — don't force a guess.\n`
    : `  "category_id": always null on this call (no category list provided).\n`;

  const categorySection = categoryLines
    ? `\n\nAvailable categories (id — label):\n${categoryLines}`
    : '';

  return `You extract structured fields from receipt photos or PDFs for a Canadian contractor. Return ONLY JSON matching this exact shape — no prose, no markdown fences. Use null for any field you cannot read with confidence.

{
  "amount_cents": INTEGER cents — receipt grand total, tax INCLUDED. e.g. $18.40 → 1840.
  "pre_tax_amount_cents": INTEGER cents — receipt SUBTOTAL before GST/HST/PST. e.g. a $113.00 total with $13.00 HST → 10000. If the receipt shows no tax line at all (out-of-province purchase, non-registered vendor, US receipt), return the same value as amount_cents and set tax_amount_cents to 0. Return null only if you cannot read the breakdown with confidence.
  "tax_amount_cents": INTEGER cents — total GST/HST/PST charged. Sum of all tax lines on the receipt (e.g. GST 5% + PST 7% = both added together). 0 if no tax shown. Null if you cannot read it.
  "vendor": merchant name as shown.
  "vendor_gst_number": the vendor's GST/HST business number if printed. Canadian format is 9 digits + "RT" + 4 digits (e.g. "123456789 RT0001"). Commonly labeled "GST Reg #", "HST #", "BN", "Business Number", or near the vendor's address. If only the 9-digit root is shown, return those 9 digits. null if not visible.
  "expense_date": "YYYY-MM-DD" — transaction date, not print time.
  "description": one short line describing what was purchased (e.g. "lumber and fasteners", "lunch for crew"). null if unclear.
${categoryField}  "card_last4": LAST 4 DIGITS of the card used to pay, if visible. Receipts show this in many shapes: "VISA ****1234", "DEBIT XXXXXXXXXXXX1234", "Card # ...1234", "Account: ************1234". Return ONLY the 4 digits as a string ("1234"), not the masked prefix. Null if no card line is visible (cash/e-transfer/cheque receipts).
  "card_network": one of "visa", "mastercard", "amex", "interac", "discover", "other" if the card brand is printed alongside the last 4. Map a plain "DEBIT" with no other brand to "interac" (Canadian default). Null if not visible.
}

Note: Canadian receipts commonly show GST/HST as "GST 5%", "HST 13%", "GST incl.", "GST INCLUDED", or "GST/HST". The amount_cents field is always the receipt total with tax included. pre_tax_amount_cents + tax_amount_cents must equal amount_cents (within 1¢ rounding) — if they don't reconcile, return null for both rather than guessing.${categorySection}`;
}

// OpenAI strict mode requires additionalProperties: false and nullable fields
// as anyOf [{type}, {type: 'null'}] — NOT type: ['X', 'null']. Gemini and
// Anthropic accept this shape too, so one schema works across all providers.
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amount_cents: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    pre_tax_amount_cents: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    tax_amount_cents: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    vendor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    vendor_gst_number: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    expense_date: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    description: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    category_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    card_last4: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    card_network: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: [
    'amount_cents',
    'pre_tax_amount_cents',
    'tax_amount_cents',
    'vendor',
    'vendor_gst_number',
    'expense_date',
    'description',
    'category_id',
    'card_last4',
    'card_network',
  ],
};

type RawReceipt = {
  amount_cents: unknown;
  pre_tax_amount_cents: unknown;
  tax_amount_cents: unknown;
  vendor: unknown;
  vendor_gst_number: unknown;
  expense_date: unknown;
  description: unknown;
  category_id: unknown;
  card_last4: unknown;
  card_network: unknown;
};

/** Parse the optional `category_options` FormData field. Invalid JSON or
 *  bad shape silently disables suggestion — the OCR still runs. */
function parseCategoryOptions(formData: FormData): ReceiptCategoryOption[] {
  const raw = formData.get('category_options');
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ReceiptCategoryOption[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.label === 'string' &&
        item.id.trim() &&
        item.label.trim() &&
        !seen.has(item.id)
      ) {
        seen.add(item.id);
        out.push({ id: item.id, label: item.label });
      }
    }
    return out;
  } catch {
    return [];
  }
}

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

  const categoryOptions = parseCategoryOptions(formData);
  const categoryLines =
    categoryOptions.length > 0
      ? categoryOptions.map((o) => `  ${o.id} — ${o.label}`).join('\n')
      : null;

  // Pull payment sources in parallel with the OCR call — the resolver
  // needs them, and the caller wants them for the picker either way.
  const paymentSourcesPromise = listPaymentSources();

  let parsed: RawReceipt;
  try {
    const res = await gateway().runStructured<RawReceipt>({
      kind: 'structured',
      task: 'receipt_ocr',
      tenant_id: tenant.id,
      prompt: buildPrompt(categoryLines),
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
  const rawPreTax =
    typeof parsed.pre_tax_amount_cents === 'number' && Number.isFinite(parsed.pre_tax_amount_cents)
      ? Math.round(parsed.pre_tax_amount_cents)
      : null;
  const rawTax =
    typeof parsed.tax_amount_cents === 'number' && Number.isFinite(parsed.tax_amount_cents)
      ? Math.round(parsed.tax_amount_cents)
      : null;
  // Sanity-check the breakdown: pre_tax + tax must equal total within 1¢
  // rounding. If it doesn't reconcile (or either part is missing), drop both
  // and let downstream fall back to amount_cents — better to under-fix one
  // expense than to ship a markup base we can't trust.
  const reconciles =
    rawPreTax !== null &&
    rawTax !== null &&
    amountCents !== null &&
    Math.abs(rawPreTax + rawTax - amountCents) <= 1;
  const preTaxAmountCents = reconciles ? rawPreTax : null;
  const taxAmountCents = reconciles ? rawTax : null;
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

  // Validate the model's suggestion against the supplied options. An id
  // that isn't in the list (made-up, hallucinated, stale) drops to null
  // silently — the caller's form falls through to a manual pick.
  const rawCategoryId =
    typeof parsed.category_id === 'string' && parsed.category_id.trim()
      ? parsed.category_id.trim()
      : null;
  const matchedCategory =
    rawCategoryId && categoryOptions.length > 0
      ? (categoryOptions.find((o) => o.id === rawCategoryId) ?? null)
      : null;

  // Card extraction + payment-source resolution. extractCardLast4 handles
  // all the masked-prefix shapes; resolvePaymentSource decides matched /
  // unknown / fallback. We always return the source catalog so the caller
  // can render the picker without a second round-trip.
  const cardLast4 = extractCardLast4(
    typeof parsed.card_last4 === 'string' ? parsed.card_last4 : null,
  );
  const cardNetwork = normalizePaymentNetwork(
    typeof parsed.card_network === 'string' ? parsed.card_network : null,
  );
  const paymentSourcesFull = await paymentSourcesPromise;
  const { paymentSourceId, resolution: paymentSourceResolution } = resolvePaymentSource(
    cardLast4,
    paymentSourcesFull,
  );

  return {
    ok: true,
    fields: {
      amountCents,
      preTaxAmountCents,
      taxAmountCents,
      vendor,
      vendorGstNumber,
      expenseDate,
      description,
      categoryId: matchedCategory?.id ?? null,
      categoryLabel: matchedCategory?.label ?? null,
      cardLast4,
      cardNetwork,
      paymentSourceId,
      paymentSourceResolution,
      paymentSources: toLite(paymentSourcesFull),
    },
  };
}
