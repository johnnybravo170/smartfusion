/**
 * QBO Estimate → HeyHenry `quotes` import.
 *
 * Estimates are pre-invoice line-item bundles. The HH `quotes` model
 * was originally built for pressure-washing map-drawn surfaces, but
 * also carries a free-form `notes` field and the same money columns
 * (subtotal_cents, tax_cents, total_cents). For QBO imports we land
 * the QBO Line[] into `notes` as a plain-text summary — the
 * surface-drawing UX doesn't apply, and the bookkeeper-facing record
 * stays inside QBO anyway.
 *
 * Status mapping (QBO TxnStatus → quotes.status):
 *   - Accepted          → 'accepted'
 *   - Rejected          → 'rejected'
 *   - Closed            → 'expired'
 *   - Pending / unset   → 'sent'
 *
 * Customer FK resolved via the same `qbo_customer_id` round-trip map
 * used by invoices. Estimates whose customer wasn't imported are
 * counted as `skipped`.
 */

import { formatCurrency } from '@/lib/pricing/calculator';
import type { QboEstimate, QboInvoiceLine } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

type QuoteStatus = 'draft' | 'sent' | 'accepted' | 'rejected' | 'expired';

function mapStatus(txnStatus: QboEstimate['TxnStatus']): QuoteStatus {
  switch (txnStatus) {
    case 'Accepted':
      return 'accepted';
    case 'Rejected':
      return 'rejected';
    case 'Closed':
      return 'expired';
    default:
      return 'sent';
  }
}

function summarizeLines(lines: QboInvoiceLine[] | undefined): string {
  if (!lines || lines.length === 0) return '';
  const rows: string[] = [];
  for (const line of lines) {
    if (!line.SalesItemLineDetail) continue;
    const desc =
      line.Description?.trim() || line.SalesItemLineDetail.ItemRef?.name?.trim() || 'Line';
    const qty = line.SalesItemLineDetail.Qty ?? 1;
    const amount = line.Amount ?? 0;
    rows.push(`${qty}× ${desc} — ${formatCurrency(Math.round(amount * 100))}`);
  }
  return rows.join('\n');
}

export function mapQboEstimateToRow(qbo: QboEstimate): {
  qbo_customer_id: string;
  row: {
    status: QuoteStatus;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    notes: string | null;
    sent_at: string | null;
    accepted_at: string | null;
  };
} {
  const totalAmt = qbo.TotalAmt ?? 0;
  // QBO Estimates don't carry a separate tax breakdown like Invoices
  // do (TxnTaxDetail is optional/missing). We land tax_cents=0 and
  // subtotal_cents=total_cents — the bookkeeper-facing record is in
  // QBO; this is the operator's working copy.
  const totalCents = Math.round(totalAmt * 100);
  const status = mapStatus(qbo.TxnStatus);
  const summary = [qbo.CustomerMemo?.value?.trim(), summarizeLines(qbo.Line)]
    .filter(Boolean)
    .join('\n\n');

  return {
    qbo_customer_id: qbo.CustomerRef.value,
    row: {
      status,
      subtotal_cents: totalCents,
      tax_cents: 0,
      total_cents: totalCents,
      notes: summary || null,
      sent_at: qbo.TxnDate ? new Date(qbo.TxnDate).toISOString() : null,
      accepted_at:
        status === 'accepted' && qbo.TxnDate ? new Date(qbo.TxnDate).toISOString() : null,
    },
  };
}

type EstimateImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  qboCustomerIdToHhId: Map<string, string>;
  qboEstimateIdToHhId: Map<string, string>;
};

async function ensureEstimateBatch(ctx: EstimateImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'quotes',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create estimate import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'quotes', id);
  return id;
}

export async function importEstimatePage(
  ctx: EstimateImportContext,
  page: QboEstimate[],
): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  type Insert = {
    qbo_estimate_id: string;
    qbo_sync_token: string;
    customer_id: string;
    row: ReturnType<typeof mapQboEstimateToRow>['row'];
  };
  type Update = {
    id: string;
    qbo: QboEstimate;
    row: ReturnType<typeof mapQboEstimateToRow>['row'];
  };

  const toInsert: Insert[] = [];
  const toUpdate: Update[] = [];
  let skipped = 0;

  for (const qbo of page) {
    const { qbo_customer_id, row } = mapQboEstimateToRow(qbo);
    const customerId = ctx.qboCustomerIdToHhId.get(qbo_customer_id);
    if (!customerId) {
      skipped += 1;
      continue;
    }
    const existingHhId = ctx.qboEstimateIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo, row });
    } else {
      toInsert.push({
        qbo_estimate_id: qbo.Id,
        qbo_sync_token: qbo.SyncToken,
        customer_id: customerId,
        row,
      });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensureEstimateBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      customer_id: r.customer_id,
      status: r.row.status,
      subtotal_cents: r.row.subtotal_cents,
      tax_cents: r.row.tax_cents,
      total_cents: r.row.total_cents,
      notes: r.row.notes,
      sent_at: r.row.sent_at,
      accepted_at: r.row.accepted_at,
      qbo_estimate_id: r.qbo_estimate_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('quotes')
      .insert(rows)
      .select('id, qbo_estimate_id');
    if (error) {
      throw new Error(`Failed to insert quotes page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_estimate_id: string | null }).qbo_estimate_id;
      if (qboId) ctx.qboEstimateIdToHhId.set(qboId, id);
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('quotes')
      .update({
        status: u.row.status,
        subtotal_cents: u.row.subtotal_cents,
        tax_cents: u.row.tax_cents,
        total_cents: u.row.total_cents,
        notes: u.row.notes,
        sent_at: u.row.sent_at,
        accepted_at: u.row.accepted_at,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update quote ${u.id}: ${error.message}`);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Estimate', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped,
  });
}

export async function loadEstimateImportContext(
  tenantId: string,
  jobId: string,
): Promise<EstimateImportContext> {
  const supabase = createAdminClient();
  const [customerRes, estimateRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, qbo_customer_id')
      .eq('tenant_id', tenantId)
      .not('qbo_customer_id', 'is', null)
      .is('deleted_at', null),
    supabase
      .from('quotes')
      .select('id, qbo_estimate_id')
      .eq('tenant_id', tenantId)
      .not('qbo_estimate_id', 'is', null),
  ]);

  if (customerRes.error) {
    throw new Error(`Failed to load customer round-trip map: ${customerRes.error.message}`);
  }
  if (estimateRes.error) {
    throw new Error(`Failed to load quotes round-trip map: ${estimateRes.error.message}`);
  }

  const qboCustomerIdToHhId = new Map<string, string>();
  for (const row of customerRes.data ?? []) {
    const r = row as { id: string; qbo_customer_id: string | null };
    if (r.qbo_customer_id) qboCustomerIdToHhId.set(r.qbo_customer_id, r.id);
  }
  const qboEstimateIdToHhId = new Map<string, string>();
  for (const row of estimateRes.data ?? []) {
    const r = row as { id: string; qbo_estimate_id: string | null };
    if (r.qbo_estimate_id) qboEstimateIdToHhId.set(r.qbo_estimate_id, r.id);
  }
  return {
    tenantId,
    jobId,
    batchIdRef: { current: null },
    qboCustomerIdToHhId,
    qboEstimateIdToHhId,
  };
}
