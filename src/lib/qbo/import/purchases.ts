/**
 * QBO Purchase → HeyHenry `expenses` import.
 *
 * QBO Purchase is a one-off outflow (Cash / Check / Credit Card)
 * without a corresponding Bill. The most natural HH home is `expenses`
 * — the running list of receipts the contractor logs throughout the
 * project.
 *
 * Pipeline:
 *   - amount_cents: TotalAmt × 100 (must be > 0 per HH CHECK constraint)
 *   - vendor (TEXT denormalized): QBO EntityRef.name (the vendor / payee)
 *   - description: concat first-line description + private note
 *   - expense_date: TxnDate
 *   - user_id: the import job's created_by (NOT NULL on expenses)
 *
 * Purchases with zero/negative TotalAmt are skipped — HH treats those
 * as data-quality issues (refunds go through a separate Refund flow).
 *
 * Idempotency on (tenant_id, qbo_purchase_id).
 */

import type { QboBillLine, QboPurchase } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

function summarizeLines(lines: QboBillLine[] | undefined): string {
  if (!lines || lines.length === 0) return '';
  return lines
    .map((l) => l.Description?.trim())
    .filter((d): d is string => Boolean(d))
    .join(' · ');
}

export function mapQboPurchaseToRow(qbo: QboPurchase): {
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  expense_date: string;
} | null {
  const amountCents = Math.round((qbo.TotalAmt ?? 0) * 100);
  if (amountCents <= 0) return null;

  const lineSummary = summarizeLines(qbo.Line);
  const note = qbo.PrivateNote?.trim() || '';
  const description = [lineSummary, note].filter(Boolean).join(' · ') || null;

  return {
    amount_cents: amountCents,
    vendor: qbo.EntityRef?.name?.trim() || qbo.AccountRef?.name?.trim() || null,
    description,
    expense_date: qbo.TxnDate ?? new Date().toISOString().slice(0, 10),
  };
}

type PurchaseImportContext = {
  tenantId: string;
  jobId: string;
  /** Created-by from qbo_import_jobs — used as expenses.user_id (NOT NULL). */
  userId: string;
  batchIdRef: { current: string | null };
  qboPurchaseIdToHhId: Map<string, string>;
};

async function ensurePurchaseBatch(ctx: PurchaseImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'expenses',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create purchase import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'expenses', id);
  return id;
}

export async function importPurchasePage(
  ctx: PurchaseImportContext,
  page: QboPurchase[],
): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  type Insert = {
    qbo_purchase_id: string;
    qbo_sync_token: string;
    row: NonNullable<ReturnType<typeof mapQboPurchaseToRow>>;
  };
  type Update = {
    id: string;
    qbo: QboPurchase;
    row: NonNullable<ReturnType<typeof mapQboPurchaseToRow>>;
  };
  const toInsert: Insert[] = [];
  const toUpdate: Update[] = [];
  let skipped = 0;

  for (const qbo of page) {
    const mapped = mapQboPurchaseToRow(qbo);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    const existingHhId = ctx.qboPurchaseIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo, row: mapped });
    } else {
      toInsert.push({
        qbo_purchase_id: qbo.Id,
        qbo_sync_token: qbo.SyncToken,
        row: mapped,
      });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensurePurchaseBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      amount_cents: r.row.amount_cents,
      vendor: r.row.vendor,
      description: r.row.description,
      expense_date: r.row.expense_date,
      qbo_purchase_id: r.qbo_purchase_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('expenses')
      .insert(rows)
      .select('id, qbo_purchase_id');
    if (error) {
      throw new Error(`Failed to insert expenses page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_purchase_id: string | null }).qbo_purchase_id;
      if (qboId) ctx.qboPurchaseIdToHhId.set(qboId, id);
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('expenses')
      .update({
        amount_cents: u.row.amount_cents,
        vendor: u.row.vendor,
        description: u.row.description,
        expense_date: u.row.expense_date,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update expense ${u.id}: ${error.message}`);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Purchase', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped,
  });
}

export async function loadPurchaseImportContext(
  tenantId: string,
  jobId: string,
  userId: string,
): Promise<PurchaseImportContext> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('expenses')
    .select('id, qbo_purchase_id')
    .eq('tenant_id', tenantId)
    .not('qbo_purchase_id', 'is', null);

  if (error) {
    throw new Error(`Failed to load purchase round-trip map: ${error.message}`);
  }

  const qboPurchaseIdToHhId = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as { id: string; qbo_purchase_id: string | null };
    if (r.qbo_purchase_id) qboPurchaseIdToHhId.set(r.qbo_purchase_id, r.id);
  }
  return {
    tenantId,
    jobId,
    userId,
    batchIdRef: { current: null },
    qboPurchaseIdToHhId,
  };
}
