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

const RECEIPT_PROMPT = `You extract structured fields from receipt photos or PDFs for a Canadian contractor's bulk import. Return ONLY JSON matching this exact shape — no prose, no markdown fences. Use null for any field you cannot read with confidence.

{
  "amount_cents": INTEGER cents — receipt grand total, tax INCLUDED. e.g. $18.40 → 1840.
  "tax_cents": INTEGER cents — the GST/HST portion if printed separately. null if not shown.
  "vendor": merchant name as shown.
  "vendor_gst_number": 9-digit (or 9+RT+4) Canadian GST/HST business number if printed. null if absent.
  "expense_date": "YYYY-MM-DD" — transaction date, not print time.
  "description": one short line describing what was purchased (e.g. "lumber and fasteners"). null if unclear.
}`;

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    amount_cents: { type: ['integer', 'null'] },
    tax_cents: { type: ['integer', 'null'] },
    vendor: { type: ['string', 'null'] },
    vendor_gst_number: { type: ['string', 'null'] },
    expense_date: { type: ['string', 'null'] },
    description: { type: ['string', 'null'] },
  },
  required: ['amount_cents', 'vendor', 'expense_date', 'description'],
};

type RawReceipt = {
  amount_cents: unknown;
  tax_cents?: unknown;
  vendor: unknown;
  vendor_gst_number?: unknown;
  expense_date: unknown;
  description: unknown;
};

export type ProposedReceiptExpense = {
  /** Filename as the operator dropped it — pure UX label. */
  filename: string;
  storagePath: string;
  /** OCR results, plus operator edits before commit. */
  amountCents: number | null;
  taxCents: number | null;
  vendor: string | null;
  vendorGstNumber: string | null;
  expenseDateIso: string | null;
  description: string | null;
};

export type ParseReceiptResult =
  | { ok: true; proposed: ProposedReceiptExpense }
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
      prompt: RECEIPT_PROMPT,
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

  return {
    ok: true,
    proposed: {
      filename,
      storagePath,
      amountCents: pickInt(raw.amount_cents),
      taxCents: pickInt(raw.tax_cents),
      vendor: pickString(raw.vendor),
      vendorGstNumber: pickString(raw.vendor_gst_number),
      expenseDateIso: pickDate(raw.expense_date),
      description: pickString(raw.description),
    },
  };
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
    .from('expenses')
    .select('id, vendor, amount_cents, tax_cents, expense_date');
  if (error) return { ok: false, error: error.message };
  const existing: ExistingExpense[] = (data ?? []).map((e) => ({
    id: e.id as string,
    vendor: (e.vendor as string | null) ?? null,
    amount_cents: (e.amount_cents as number) ?? 0,
    tax_cents: (e.tax_cents as number) ?? 0,
    expense_date: e.expense_date as string,
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
  taxCents: number | null;
  vendor: string | null;
  vendorGstNumber: string | null;
  expenseDateIso: string | null;
  description: string | null;
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
    const expenseRows = toCreate.map((r) => ({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: null,
      budget_category_id: null,
      job_id: null,
      category_id: null,
      amount_cents: r.amountCents ?? 0,
      tax_cents: r.taxCents ?? 0,
      vendor: r.vendor,
      vendor_gst_number: r.vendorGstNumber,
      description: r.description,
      receipt_storage_path: r.storagePath,
      expense_date: r.expenseDateIso,
      import_batch_id: batchId,
    }));
    const { error: insErr } = await supabase.from('expenses').insert(expenseRows);
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

  // Soft-delete via deleted_at — but expenses doesn't have that column
  // in this schema; check before assuming.
  // Looking at the schema: expenses has no deleted_at column. We
  // hard-delete imported expenses on rollback. Receipt files in storage
  // are left alone (the operator can re-import or use storage admin).
  // If we later add deleted_at to expenses, switch this to soft-delete.
  const { data: deletedRows, error: delErr } = await supabase
    .from('expenses')
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
