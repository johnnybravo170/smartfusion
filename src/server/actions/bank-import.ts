'use server';

/**
 * Bank statement import actions for BR-4. Two-stage flow:
 *
 *   1. parseBankStatementAction(formData) — runs BR-2's parser against the
 *      uploaded CSV, returns a preview. No DB writes.
 *   2. importBankStatementAction(formData) — re-parses with confirmed
 *      overrides + writes bank_statements + bank_transactions. Idempotent
 *      via the unique (tenant_id, dedup_hash) constraint — re-uploading
 *      the same file silently skips already-imported transactions.
 *
 * The parser ignores tenancy entirely; this layer handles tenant scoping,
 * dedup hashing, and the DB round-trip.
 */

import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { type BankPreset, type ParsedStatement, parseBankStatement } from '@/lib/bank-recon';
import { createClient } from '@/lib/supabase/server';

const MAX_BYTES = 5 * 1024 * 1024;

const overridesSchema = z.object({
  date: z.number().int().min(0).optional(),
  description: z.number().int().min(0).optional(),
  amount: z.number().int().min(-1).optional(),
  debit: z.number().int().min(0).optional(),
  credit: z.number().int().min(0).optional(),
  date_format: z
    .enum([
      'YYYY-MM-DD',
      'YYYY/MM/DD',
      'YYYYMMDD',
      'DD/MM/YYYY',
      'D/M/YYYY',
      'MM/DD/YYYY',
      'M/D/YYYY',
    ])
    .optional(),
});

const presetSchema = z.enum(['rbc', 'td', 'bmo', 'scotia', 'cibc', 'amex', 'generic']);

function parseOverrides(raw: FormDataEntryValue | null) {
  if (!raw || typeof raw !== 'string') return undefined;
  try {
    const parsed = overridesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function parsePreset(raw: FormDataEntryValue | null): BankPreset | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const parsed = presetSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

async function readFile(
  formData: FormData,
): Promise<{ ok: true; buffer: Buffer; filename: string | null } | { ok: false; error: string }> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded.' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: 'File is larger than 5MB.' };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  return { ok: true, buffer: buf, filename: file.name || null };
}

// ---------------------------------------------------------------------------
// 1. Preview — parse only, no DB write
// ---------------------------------------------------------------------------

export type ParsePreviewResult =
  | {
      ok: true;
      data: ParsedStatement;
      filename: string | null;
    }
  | { ok: false; error: string };

export async function parseBankStatementAction(formData: FormData): Promise<ParsePreviewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = await readFile(formData);
  if (!file.ok) return file;

  const result = parseBankStatement(file.buffer, {
    filename: file.filename ?? undefined,
    preset_hint: parsePreset(formData.get('preset_hint')),
    manual_overrides: parseOverrides(formData.get('manual_overrides')),
  });
  if (!result.ok) return { ok: false, error: result.error };

  return { ok: true, data: result.data, filename: file.filename };
}

// ---------------------------------------------------------------------------
// 2. Import — parse + write
// ---------------------------------------------------------------------------

const importSchema = z.object({
  source_label: z.string().trim().min(1, 'Statement label is required.').max(200),
});

export type ImportBankStatementResult =
  | {
      ok: true;
      statement_id: string;
      total_rows: number;
      inserted: number;
      skipped_duplicates: number;
      warnings: number;
    }
  | { ok: false; error: string };

export async function importBankStatementAction(
  formData: FormData,
): Promise<ImportBankStatementResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();

  const meta = importSchema.safeParse({
    source_label: formData.get('source_label'),
  });
  if (!meta.success) {
    return { ok: false, error: meta.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const file = await readFile(formData);
  if (!file.ok) return file;

  const presetHint = parsePreset(formData.get('preset_hint'));
  const parsed = parseBankStatement(file.buffer, {
    filename: file.filename ?? undefined,
    preset_hint: presetHint,
    manual_overrides: parseOverrides(formData.get('manual_overrides')),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const supabase = await createClient();

  // 1. Insert the parent statement row.
  const { data: stmt, error: stmtErr } = await supabase
    .from('bank_statements')
    .insert({
      tenant_id: tenant.id,
      source_label: meta.data.source_label,
      bank_preset: parsed.data.detected_preset ?? presetHint ?? null,
      filename: file.filename,
      uploaded_by: user?.id ?? null,
      row_count: parsed.data.rows.length,
      matched_count: 0,
    })
    .select('id')
    .single();
  if (stmtErr || !stmt) {
    return { ok: false, error: stmtErr?.message ?? 'Failed to record statement.' };
  }

  // 2. Build transaction rows with dedup hashes.
  const txRows = parsed.data.rows.map((tx) => ({
    tenant_id: tenant.id,
    statement_id: stmt.id,
    posted_at: tx.posted_at,
    amount_cents: tx.amount_cents,
    description: tx.description,
    raw_row: tx.raw,
    dedup_hash: dedupHash(tenant.id, tx.posted_at, tx.amount_cents, tx.description_normalized),
  }));

  // 3. Bulk insert. Conflicts on (tenant_id, dedup_hash) are silently
  // skipped — that's the idempotency guarantee.
  let inserted = 0;
  if (txRows.length > 0) {
    const { data: ins, error: insErr } = await supabase
      .from('bank_transactions')
      .upsert(txRows, {
        onConflict: 'tenant_id,dedup_hash',
        ignoreDuplicates: true,
      })
      .select('id');
    if (insErr) {
      return { ok: false, error: insErr.message };
    }
    inserted = ins?.length ?? 0;
  }

  // 4. Update row_count to reflect what was actually inserted (parsed
  // rows include duplicates, but the DB only got `inserted` of them).
  if (inserted !== txRows.length) {
    await supabase.from('bank_statements').update({ row_count: inserted }).eq('id', stmt.id);
  }

  revalidatePath('/business-health');
  revalidatePath('/business-health/bank-import');

  return {
    ok: true,
    statement_id: stmt.id,
    total_rows: txRows.length,
    inserted,
    skipped_duplicates: txRows.length - inserted,
    warnings: parsed.data.warnings.length,
  };
}

// ---------------------------------------------------------------------------
// Dedup hash
// ---------------------------------------------------------------------------

function dedupHash(
  tenantId: string,
  postedAt: string,
  amountCents: number,
  descriptionNormalized: string,
): string {
  const input = `${tenantId}|${postedAt}|${amountCents}|${descriptionNormalized}`;
  return createHash('sha256').update(input).digest('hex');
}
