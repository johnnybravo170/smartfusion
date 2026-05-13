'use server';

/**
 * Phase D of the onboarding import wizard. Bulk receipts → expenses.
 *
 * Different shape than A/B/C: input is a pile of PDFs and image
 * files, not a single text-shaped sheet. Each file is OCR'd
 * independently via the gateway's receipt_ocr task — the same one the
 * live single-receipt flow uses (see extract-receipt.ts). That makes
 * each parse call cheap (one file, ~5–15s) and avoids the "50
 * receipts × 10s blows past maxDuration" trap a single bulk action
 * would hit.
 *
 * Flow:
 *
 *   1. Client iterates the dropped files. For each, it calls
 *      `parseReceiptForImportAction(formData)` which OCRs the file,
 *      uploads it to the existing `receipts` storage bucket, and
 *      returns the proposed expense fields plus the storage path.
 *   2. As results come in, the wizard builds a preview list with
 *      progress UI ("Reading 5 of 23…"). The operator can edit any
 *      field inline.
 *   3. Once happy, the operator clicks "Bring them in" and
 *      `commitReceiptImportAction({ rows, ... })` opens the batch
 *      and bulk-inserts every expense in one transaction-equivalent.
 *
 * On rollback, both expenses and their receipt files are soft-removed
 * (file removal is best-effort — storage paths persist if the call
 * fails so the operator can retry).
 */

import { randomUUID } from 'node:crypto';
import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import {
  buildCategoryTree,
  buildPickerOptions,
  listExpenseCategories,
} from '@/lib/db/queries/expense-categories';
import {
  listPaymentSources,
  type PaymentSourceLite,
  type PaymentSourceNetwork,
  toLite,
} from '@/lib/db/queries/payment-sources';
import {
  type ExistingExpense,
  type ExpenseMatchTier,
  expenseTierLabel,
  findExpenseMatch,
} from '@/lib/expenses/dedup';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_RECEIPT_BYTES = 10 * 1024 * 1024; // matches single-receipt flow
const RECEIPTS_BUCKET = 'receipts';

// ─── Single-receipt parse ──────────────────────────────────────────────────

function buildReceiptPrompt(categoryLines: string): string {
  return `You extract structured fields from receipt photos or PDFs for a Canadian contractor's bulk import. Return ONLY JSON matching the schema. Use null for any field you cannot read with confidence.

Fields:
  "amount_cents": INTEGER cents — receipt grand total, tax INCLUDED. e.g. $18.40 → 1840.
  "pre_tax_amount_cents": INTEGER cents — receipt SUBTOTAL before tax. e.g. $113.00 total with $13.00 HST → 10000. If no tax line is shown, return the same value as amount_cents. null only if you can't read it confidently.
  "tax_cents": INTEGER cents — the GST/HST portion if printed separately. null if not shown.
  "vendor": merchant name as shown.
  "vendor_gst_number": 9-digit (or 9+RT+4) Canadian GST/HST business number if printed. null if absent.
  "expense_date": "YYYY-MM-DD" — transaction date, not print time.
  "description": one short line describing what was purchased (e.g. "lumber and fasteners"). null if unclear.
  "category_id": pick the BEST matching category from the contractor's chart of accounts below. Match on the kind of purchase (lumber → "Materials"; gas → "Vehicle: Fuel"; etc.). If nothing fits or you genuinely can't tell, return null — don't force a guess.
  "card_last4": LAST 4 DIGITS of the card used to pay, if visible. Receipts show this in many shapes: "VISA ****1234", "DEBIT XXXXXXXXXXXX1234", "Card # ...1234", "Account: ************1234". Return ONLY the 4 digits as a string ("1234"), not the masked prefix. Null if no card line is visible (cash/e-transfer/cheque receipts).
  "card_network": one of "visa", "mastercard", "amex", "interac", "discover", "other" if the card brand is printed alongside the last 4. Return null if not visible. Map "DEBIT" with no other brand to "interac" (Canadian default debit).

Available categories (id — label):
${categoryLines}`;
}

// OpenAI strict-mode structured output requires every property in
// `properties` to also appear in `required`, and `additionalProperties:
// false`. Otherwise the API 400s before any model runs (visible as
// status=invalid_input, latency_ms=0 in ai_calls). Gemini is more
// forgiving but the gateway falls over to OpenAI on overload, so the
// schema must satisfy the strictest provider.
const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    amount_cents: { type: ['integer', 'null'] },
    pre_tax_amount_cents: { type: ['integer', 'null'] },
    tax_cents: { type: ['integer', 'null'] },
    vendor: { type: ['string', 'null'] },
    vendor_gst_number: { type: ['string', 'null'] },
    expense_date: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
    category_id: { type: ['string', 'null'] },
    card_last4: { type: ['string', 'null'] },
    card_network: { type: ['string', 'null'] },
  },
  required: [
    'amount_cents',
    'pre_tax_amount_cents',
    'tax_cents',
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
  pre_tax_amount_cents?: unknown;
  tax_cents?: unknown;
  vendor: unknown;
  vendor_gst_number?: unknown;
  expense_date: unknown;
  description: unknown;
  category_id?: unknown;
  card_last4?: unknown;
  card_network?: unknown;
};

export type ProposedReceiptExpense = {
  /** Filename as the operator dropped it — pure UX label. */
  filename: string;
  storagePath: string;
  /** OCR results, plus operator edits before commit. */
  amountCents: number | null;
  /** Receipt subtotal before GST/HST/PST. Used as the markup base on
   *  cost-plus client invoices. Null when OCR couldn't read the breakdown
   *  or it doesn't reconcile to amount_cents within ~1¢. */
  preTaxAmountCents: number | null;
  taxCents: number | null;
  vendor: string | null;
  vendorGstNumber: string | null;
  expenseDateIso: string | null;
  description: string | null;
  /** Henry's category suggestion, validated against the tenant's
   *  expense_categories. null when no confident match. */
  categoryId: string | null;
  /** Pre-resolved label so the wizard doesn't have to round-trip. */
  categoryLabel: string | null;
  /** Card last 4 extracted from the receipt, if visible. */
  cardLast4: string | null;
  /** Card network if visible alongside the last 4. */
  cardNetwork: PaymentSourceNetwork | null;
  /** Pre-resolved payment source — either a registered card matching
   *  card_last4, or the tenant default if no card was seen. null only
   *  if even the default lookup failed. */
  paymentSourceId: string | null;
  /** Tag so the wizard can render an "Unknown card — label this?"
   *  affordance vs a normal source pill. */
  paymentSourceResolution: 'matched_card' | 'unknown_card' | 'fallback_default' | 'none';
};

/** Returned alongside the first proposed result so the wizard can render
 *  a category picker for operator overrides. */
export type CategoryPickerOptionLite = {
  id: string;
  label: string;
  isParentHeader: boolean;
};

export type ParseReceiptResult =
  | {
      ok: true;
      proposed: ProposedReceiptExpense;
      /** Categories returned with every parse so the client always has
       *  the freshest picker options without an extra round-trip. */
      categories: CategoryPickerOptionLite[];
      /** Same idea for payment sources — kept fresh between parses so
       *  if the operator just labeled a card, the next row sees it. */
      paymentSources: PaymentSourceLite[];
    }
  | { ok: false; error: string; filename: string };

function userSafeError(
  err: unknown,
  filename: string,
): {
  ok: false;
  error: string;
  filename: string;
} {
  if (isAiError(err)) {
    if (err.kind === 'quota')
      return { ok: false, error: 'Henry is temporarily unavailable.', filename };
    if (err.kind === 'overload' || err.kind === 'rate_limit')
      return { ok: false, error: 'Henry is busy right now.', filename };
    if (err.kind === 'timeout')
      return { ok: false, error: 'OCR timed out — try this one again.', filename };
  }
  return { ok: false, error: 'Could not read this receipt.', filename };
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function pickInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null;
}

function pickDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

function extFromContentType(mime: string): string {
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Parse and archive ONE receipt. Called once per dropped file from the
 * client. Cheap, sequential round-trips beat one giant action timing
 * out on the 50th file.
 */
export async function parseReceiptForImportAction(formData: FormData): Promise<ParseReceiptResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.', filename: '' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.', filename: '' };

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No receipt provided.', filename: '' };
  }
  const filename = file.name;
  if (file.size > MAX_RECEIPT_BYTES) {
    return { ok: false, error: 'Receipt is larger than 10MB.', filename };
  }

  const mime = file.type || 'image/jpeg';
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  if (!isPdf && !isImage) {
    return { ok: false, error: `Unsupported file type: ${mime}`, filename };
  }

  // Pull the tenant's expense categories so Henry can suggest one per
  // receipt — the showcase moment. listExpenseCategories is React.cache-
  // wrapped so within a request it's free, and across requests it's a
  // single index-backed query (~10ms).
  const categoryRows = await listExpenseCategories();
  const categoryTree = buildCategoryTree(categoryRows);
  const pickerOptions = buildPickerOptions(categoryTree);
  const categoryById = new Map(pickerOptions.map((o) => [o.id, o.label]));
  // Hide parent-headers from the model so it never picks an unselectable
  // bucket — only true leaf-or-childless categories.
  const selectableCategories = pickerOptions.filter((o) => !o.isParentHeader);
  const categoryLines = selectableCategories.map((o) => `  ${o.id} — ${o.label}`).join('\n');

  // Payment sources: pull once per parse so we can pre-resolve last4 →
  // source on the server (cheap, no extra round-trip from the wizard).
  const paymentSourceRows = await listPaymentSources();
  const paymentSourcesLite = toLite(paymentSourceRows);
  const sourceByLast4 = new Map<string, PaymentSourceLite>();
  for (const s of paymentSourcesLite) {
    if (s.last4) sourceByLast4.set(s.last4, s);
  }
  const defaultSourceId = paymentSourcesLite.find((s) => s.is_default)?.id ?? null;

  // OCR first, archive second — if the OCR call fails (quota, etc.) we
  // don't leave orphan storage objects around.
  const buf = Buffer.from(await file.arrayBuffer());
  const base64 = buf.toString('base64');

  let raw: RawReceipt;
  try {
    const res = await gateway().runStructured<RawReceipt>({
      kind: 'structured',
      task: 'receipt_ocr',
      tenant_id: tenant.id,
      prompt: buildReceiptPrompt(categoryLines || '  (no categories configured)'),
      schema: RECEIPT_SCHEMA,
      file: { mime, base64, filename: file.name },
      temperature: 0.1,
    });
    raw = res.data;
  } catch (err) {
    return userSafeError(err, filename);
  }

  // Archive to the same `receipts` bucket the live single-expense flow
  // uses, with the same path convention.
  const admin = createAdminClient();
  const ext = extFromContentType(mime);
  const storagePath = `${tenant.id}/${user.id}/${randomUUID()}.${ext}`;
  const { error: upErr } = await admin.storage
    .from(RECEIPTS_BUCKET)
    .upload(storagePath, buf, { contentType: mime, upsert: false });
  if (upErr) {
    return { ok: false, error: `Receipt archive failed: ${upErr.message}`, filename };
  }

  // Validate the model's category suggestion: only accept ids that
  // exist in the tenant's selectable categories. Anything else (made-
  // up id, parent-header id, stale id) drops to null silently — the
  // operator picks via the wizard's category cell.
  const rawCategoryId = pickString(raw.category_id);
  const validCategoryId = rawCategoryId && categoryById.has(rawCategoryId) ? rawCategoryId : null;
  const categoryLabel = validCategoryId ? (categoryById.get(validCategoryId) ?? null) : null;

  // Card last 4 — strip everything except the last 4 digits, since
  // models occasionally hand back the full mask ("****1234").
  const rawCardLast4 = pickString(raw.card_last4);
  const cardLast4 = rawCardLast4 ? extractLast4(rawCardLast4) : null;
  const cardNetwork = normalizeNetwork(pickString(raw.card_network));

  // Pre-resolve the payment source server-side so the wizard renders
  // instantly without a follow-up round-trip per row.
  let paymentSourceId: string | null = null;
  let paymentSourceResolution: ProposedReceiptExpense['paymentSourceResolution'] = 'none';
  if (cardLast4) {
    const matched = sourceByLast4.get(cardLast4);
    if (matched) {
      paymentSourceId = matched.id;
      paymentSourceResolution = 'matched_card';
    } else {
      paymentSourceResolution = 'unknown_card';
    }
  } else if (defaultSourceId) {
    paymentSourceId = defaultSourceId;
    paymentSourceResolution = 'fallback_default';
  }

  return {
    ok: true,
    proposed: {
      filename,
      storagePath,
      amountCents: pickInt(raw.amount_cents),
      preTaxAmountCents: reconcilePreTax(
        pickInt(raw.pre_tax_amount_cents),
        pickInt(raw.tax_cents),
        pickInt(raw.amount_cents),
      ),
      taxCents: pickInt(raw.tax_cents),
      vendor: pickString(raw.vendor),
      vendorGstNumber: pickString(raw.vendor_gst_number),
      expenseDateIso: pickDate(raw.expense_date),
      description: pickString(raw.description),
      categoryId: validCategoryId,
      categoryLabel,
      cardLast4,
      cardNetwork,
      paymentSourceId,
      paymentSourceResolution,
    },
    categories: pickerOptions.map((o) => ({
      id: o.id,
      label: o.label,
      isParentHeader: o.isParentHeader,
    })),
    paymentSources: paymentSourcesLite,
  };
}

const NETWORK_VALUES: PaymentSourceNetwork[] = [
  'visa',
  'mastercard',
  'amex',
  'interac',
  'discover',
  'other',
];

function normalizeNetwork(v: string | null): PaymentSourceNetwork | null {
  if (!v) return null;
  const lc = v.toLowerCase().trim();
  return (NETWORK_VALUES as string[]).includes(lc) ? (lc as PaymentSourceNetwork) : null;
}

function extractLast4(raw: string): string | null {
  // Pull the last 4 digits from anywhere in the string. Handles
  // "****1234", "1234", "DEBIT 1234", "...1234" alike.
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 4) return null;
  return digits.slice(-4);
}

/**
 * Sanity-check the OCR'd pre-tax / tax / total breakdown. Returns the
 * pre-tax value only if pre_tax + tax = total within 1¢ rounding. If
 * pre_tax is missing but tax + total are present and sensible, derive
 * pre_tax = total - tax. Otherwise null — the cost-plus markup falls
 * back to amount_cents.
 */
function reconcilePreTax(
  preTax: number | null,
  tax: number | null,
  total: number | null,
): number | null {
  if (total === null) return null;
  if (preTax !== null && tax !== null) {
    return Math.abs(preTax + tax - total) <= 1 ? preTax : null;
  }
  if (preTax === null && tax !== null && tax >= 0 && tax <= total) {
    return total - tax;
  }
  return null;
}

// ─── Dedup-against-existing query ──────────────────────────────────────────

export type ReceiptDedupHint = {
  filename: string;
  match: {
    tier: ExpenseMatchTier;
    label: string;
    existingId: string | null;
  };
};

/**
 * After all receipts have parsed, the wizard calls this once with the
 * list of proposed expenses to fetch dedup hints in a single round-
 * trip. Returned hints are keyed by filename so the client can splice
 * them into its proposal state.
 */
export async function dedupReceiptProposalsAction(
  proposals: Array<{
    filename: string;
    vendor: string | null;
    amountCents: number | null;
    taxCents: number | null;
    expenseDateIso: string | null;
  }>,
): Promise<{ ok: true; hints: ReceiptDedupHint[] } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_costs')
    .select('id, vendor, amount_cents, gst_cents, cost_date')
    .eq('source_type', 'receipt')
    .eq('status', 'active');
  if (error) return { ok: false, error: error.message };
  const existing: ExistingExpense[] = (data ?? []).map((e) => ({
    id: e.id as string,
    vendor: (e.vendor as string | null) ?? null,
    amount_cents: (e.amount_cents as number) ?? 0,
    tax_cents: (e.gst_cents as number) ?? 0,
    expense_date: e.cost_date as string,
  }));

  const hints: ReceiptDedupHint[] = proposals.map((p) => {
    if (!p.vendor || p.amountCents === null || !p.expenseDateIso) {
      return {
        filename: p.filename,
        match: { tier: null, label: '', existingId: null },
      };
    }
    const m = findExpenseMatch(
      {
        vendor: p.vendor,
        totalCents: p.amountCents + (p.taxCents ?? 0),
        expenseDateIso: p.expenseDateIso,
      },
      existing,
    );
    return {
      filename: p.filename,
      match: {
        tier: m.tier,
        label: expenseTierLabel(m.tier),
        existingId: m.existing?.id ?? null,
      },
    };
  });

  return { ok: true, hints };
}

// ─── Commit ────────────────────────────────────────────────────────────────

export type CommitReceiptImportRow = {
  filename: string;
  storagePath: string;
  decision: 'create' | 'merge' | 'skip';
  amountCents: number | null;
  /** Pre-tax subtotal — markup base on cost-plus jobs. Null falls back
   *  to amountCents. */
  preTaxAmountCents: number | null;
  taxCents: number | null;
  vendor: string | null;
  vendorGstNumber: string | null;
  expenseDateIso: string | null;
  description: string | null;
  /** Henry-suggested or operator-picked. null = uncategorized
   *  (operator can categorize later via the expense detail page). */
  categoryId: string | null;
  /** Resolved at preview time — either matched-card, post-label-this-card,
   *  or the tenant default. Falls back server-side to the tenant default
   *  if the operator clears it. */
  paymentSourceId: string | null;
  /** Snapshot of the last 4 the OCR pulled, written verbatim to the
   *  expense row for audit. Independent of paymentSourceId so the
   *  receipt stays unambiguous if the source is later renamed/archived. */
  cardLast4: string | null;
};

export type CommitReceiptImportResult =
  | {
      ok: true;
      batchId: string;
      created: number;
      merged: number;
      skipped: number;
    }
  | { ok: false; error: string };

export async function commitReceiptImportAction(input: {
  rows: CommitReceiptImportRow[];
  note: string | null;
}): Promise<CommitReceiptImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const merged = input.rows.filter((r) => r.decision === 'merge').length;
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;

  const insufficient = toCreate.filter((r) => r.amountCents === null || !r.expenseDateIso);
  if (insufficient.length > 0) {
    return {
      ok: false,
      error: `${insufficient.length} receipt${insufficient.length === 1 ? ' is' : 's are'} missing the amount or date. Fill them in or set those rows to skip.`,
    };
  }

  if (toCreate.length === 0 && merged === 0) {
    return { ok: false, error: 'Nothing to commit — every row is set to skip.' };
  }

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'expenses',
      source_filename:
        toCreate.length === 1 ? toCreate[0].filename : `${input.rows.length} receipts`,
      summary: { created: toCreate.length, merged, skipped },
      note: input.note?.trim() || null,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  if (toCreate.length > 0) {
    // Fall back to the tenant default source for any row the operator
    // didn't explicitly resolve. Avoids leaving a fleet of rows with
    // null payment_source_id just because OCR didn't see a card.
    const fallbackSources = await listPaymentSources();
    const fallbackDefaultId = fallbackSources.find((s) => s.is_default)?.id ?? null;

    const now = new Date().toISOString();
    const costRows = toCreate.map((r) => ({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: null,
      budget_category_id: null,
      job_id: null,
      category_id: r.categoryId,
      amount_cents: r.amountCents ?? 0,
      pre_tax_amount_cents: r.preTaxAmountCents,
      gst_cents: r.taxCents ?? 0,
      vendor: r.vendor,
      vendor_gst_number: r.vendorGstNumber,
      description: r.description,
      attachment_storage_path: r.storagePath,
      cost_date: r.expenseDateIso,
      import_batch_id: batchId,
      payment_source_id: r.paymentSourceId ?? fallbackDefaultId,
      card_last4: r.cardLast4,
      source_type: 'receipt',
      payment_status: 'paid',
      paid_at: now,
      status: 'active',
    }));
    const { error: insErr } = await supabase.from('project_costs').insert(costRows);
    if (insErr) {
      // Best-effort cleanup: drop the batch so it doesn't dangle. Don't
      // remove storage objects here — the operator may want to retry.
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: insErr.message };
    }
  }

  return { ok: true, batchId, created: toCreate.length, merged, skipped };
}

// ─── Rollback ──────────────────────────────────────────────────────────────

export async function rollbackReceiptImportAction(
  batchId: string,
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, kind, rolled_back_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchErr || !batch) return { ok: false, error: 'Batch not found.' };
  if (batch.rolled_back_at) return { ok: false, error: 'Batch already rolled back.' };
  if (batch.kind !== 'expenses') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches with the receipt rollback action.`,
    };
  }

  const now = new Date().toISOString();

  // Hard-delete imported receipts on rollback. project_costs has a
  // deleted_at column we could use to soft-delete, but the batch-level
  // rolled_back_at on import_batches already gives us the audit trail
  // and the rows themselves aren't referenced by anything else (the
  // FK out of cost_line_actuals etc. points the other way). Receipt
  // files in storage are left alone — the operator can re-import or
  // use storage admin.
  const { data: deletedRows, error: delErr } = await supabase
    .from('project_costs')
    .delete()
    .eq('import_batch_id', batchId)
    .select('id');
  if (delErr) return { ok: false, error: delErr.message };

  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return { ok: true, deleted: (deletedRows ?? []).length };
}
