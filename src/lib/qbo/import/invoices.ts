/**
 * QBO Invoice → HeyHenry `invoices` import.
 *
 * Pipeline:
 *   1. Look up customer by `(tenant_id, qbo_customer_id)`. Skip if the
 *      customer wasn't imported (caller-controlled — Phase 4b only
 *      runs invoices when customers were imported in the same job, or
 *      already exist from a prior run).
 *   2. Idempotency on `(tenant_id, qbo_invoice_id)` — re-runs UPDATE
 *      in place rather than insert dupes.
 *   3. Money math: amount_cents = TotalAmt - TotalTax, tax_cents =
 *      TotalTax. Both kept frozen at historical QBO values per the
 *      money-math-frozen contract (see migration
 *      0187_invoices_import_batch.sql comments).
 *   4. Status mapping:
 *      - Void=true        → 'void'
 *      - Balance === 0    → 'paid'
 *      - default          → 'sent' (QBO emits invoices in a sent state)
 *   5. Line items: denormalize QBO `Line[]` into the existing
 *      `invoices.line_items` JSONB shape. Skip non-billable control
 *      rows (SubTotal/Discount/Group control rows).
 *
 * Customers that don't exist (foreign-key mismatch) bubble up as
 * `skipped` on the entity counters — we don't auto-create stub
 * customers because QBO's Customer entity is the source of truth for
 * customer detail.
 */

import type { QboInvoice, QboInvoiceLine } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
};

/**
 * Map QBO Invoice → HH row shape, including denormalized line_items.
 * Returns the row plus the QBO customer id we need to resolve to an
 * HH customer_id before insert.
 */
export function mapQboInvoiceToRow(qbo: QboInvoice): {
  qbo_customer_id: string;
  row: {
    status: 'sent' | 'paid' | 'void';
    amount_cents: number;
    tax_cents: number;
    line_items: InvoiceLineItem[];
    customer_note: string | null;
    sent_at: string | null;
    paid_at: string | null;
  };
} {
  const totalAmt = qbo.TotalAmt ?? 0;
  const totalTax = qbo.TxnTaxDetail?.TotalTax ?? 0;
  const balance = qbo.Balance ?? 0;

  const status: 'sent' | 'paid' | 'void' = qbo.Void ? 'void' : balance === 0 ? 'paid' : 'sent';

  const amountCents = Math.round((totalAmt - totalTax) * 100);
  const taxCents = Math.round(totalTax * 100);

  return {
    qbo_customer_id: qbo.CustomerRef.value,
    row: {
      status,
      amount_cents: Math.max(amountCents, 0),
      tax_cents: Math.max(taxCents, 0),
      line_items: mapInvoiceLines(qbo.Line ?? []),
      customer_note: qbo.CustomerMemo?.value?.trim() || null,
      // QBO emits invoices already "sent" — use TxnDate as the proxy
      // for sent_at. paid_at is the TxnDate when fully paid; if not,
      // null. We don't have per-payment dates without joining Payments,
      // which Phase 4c handles.
      sent_at: qbo.TxnDate ? new Date(qbo.TxnDate).toISOString() : null,
      paid_at: status === 'paid' && qbo.TxnDate ? new Date(qbo.TxnDate).toISOString() : null,
    },
  };
}

export function mapInvoiceLines(lines: QboInvoiceLine[]): InvoiceLineItem[] {
  const out: InvoiceLineItem[] = [];
  for (const line of lines) {
    // SubTotal / Discount / Group control rows have no SalesItemLineDetail
    // and don't represent actual sellable items. Skip — the totals are
    // already on the invoice header.
    if (!line.SalesItemLineDetail) continue;
    const detail = line.SalesItemLineDetail;
    const amount = line.Amount ?? 0;
    const qty = detail.Qty ?? 1;
    const unitPrice = detail.UnitPrice ?? (qty > 0 ? amount / qty : amount);
    out.push({
      description: line.Description?.trim() || detail.ItemRef?.name?.trim() || 'Line item',
      quantity: qty,
      unit_price_cents: Math.round(unitPrice * 100),
      total_cents: Math.round(amount * 100),
    });
  }
  return out;
}

type InvoiceImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  /** QBO customer id → HH customer id. Required for FK resolution. */
  qboCustomerIdToHhId: Map<string, string>;
  /** QBO invoice id → HH invoice id, for round-trip update path. */
  qboInvoiceIdToHhId: Map<string, string>;
};

async function ensureInvoiceBatch(ctx: InvoiceImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'invoices',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create invoice import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'invoices', id);
  return id;
}

export async function importInvoicePage(
  ctx: InvoiceImportContext,
  page: QboInvoice[],
): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  const toInsert: Array<{
    qbo_invoice_id: string;
    qbo_sync_token: string;
    customer_id: string;
    row: ReturnType<typeof mapQboInvoiceToRow>['row'];
  }> = [];
  const toUpdate: Array<{
    id: string;
    qbo: QboInvoice;
    customer_id: string;
    row: ReturnType<typeof mapQboInvoiceToRow>['row'];
  }> = [];
  let skipped = 0;

  for (const qbo of page) {
    const { qbo_customer_id, row } = mapQboInvoiceToRow(qbo);
    const customerId = ctx.qboCustomerIdToHhId.get(qbo_customer_id);
    if (!customerId) {
      // Customer not in HH — likely not imported yet, or skipped to
      // the review queue. Skip the invoice; user can re-run after
      // resolving the customer review queue.
      skipped += 1;
      continue;
    }

    const existingHhId = ctx.qboInvoiceIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo, customer_id: customerId, row });
    } else {
      toInsert.push({
        qbo_invoice_id: qbo.Id,
        qbo_sync_token: qbo.SyncToken,
        customer_id: customerId,
        row,
      });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensureInvoiceBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      customer_id: r.customer_id,
      status: r.row.status,
      amount_cents: r.row.amount_cents,
      tax_cents: r.row.tax_cents,
      line_items: r.row.line_items,
      customer_note: r.row.customer_note,
      sent_at: r.row.sent_at,
      paid_at: r.row.paid_at,
      qbo_invoice_id: r.qbo_invoice_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('invoices')
      .insert(rows)
      .select('id, qbo_invoice_id');
    if (error) {
      throw new Error(`Failed to insert invoices page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_invoice_id: string | null }).qbo_invoice_id;
      if (qboId) ctx.qboInvoiceIdToHhId.set(qboId, id);
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('invoices')
      .update({
        // Imported invoices have FROZEN money math (see migration
        // 0187_invoices_import_batch.sql) — but the source of truth is
        // QBO, so on re-import we refresh status / line_items / notes.
        // amount_cents and tax_cents only change if QBO recomputed them.
        status: u.row.status,
        amount_cents: u.row.amount_cents,
        tax_cents: u.row.tax_cents,
        line_items: u.row.line_items,
        customer_note: u.row.customer_note,
        sent_at: u.row.sent_at,
        paid_at: u.row.paid_at,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update invoice ${u.id}: ${error.message}`);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Invoice', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped,
  });
}

export async function loadInvoiceImportContext(
  tenantId: string,
  jobId: string,
): Promise<InvoiceImportContext> {
  const supabase = createAdminClient();

  // Pull the customer round-trip map. Phase 4b runs after Customer in
  // the same job, so this includes any customers we just imported plus
  // every previously-imported one.
  const [customerRes, invoiceRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, qbo_customer_id')
      .eq('tenant_id', tenantId)
      .not('qbo_customer_id', 'is', null)
      .is('deleted_at', null),
    supabase
      .from('invoices')
      .select('id, qbo_invoice_id')
      .eq('tenant_id', tenantId)
      .not('qbo_invoice_id', 'is', null),
  ]);

  if (customerRes.error) {
    throw new Error(`Failed to load customer round-trip map: ${customerRes.error.message}`);
  }
  if (invoiceRes.error) {
    throw new Error(`Failed to load invoice round-trip map: ${invoiceRes.error.message}`);
  }

  const qboCustomerIdToHhId = new Map<string, string>();
  for (const row of customerRes.data ?? []) {
    const r = row as { id: string; qbo_customer_id: string | null };
    if (r.qbo_customer_id) qboCustomerIdToHhId.set(r.qbo_customer_id, r.id);
  }
  const qboInvoiceIdToHhId = new Map<string, string>();
  for (const row of invoiceRes.data ?? []) {
    const r = row as { id: string; qbo_invoice_id: string | null };
    if (r.qbo_invoice_id) qboInvoiceIdToHhId.set(r.qbo_invoice_id, r.id);
  }

  return {
    tenantId,
    jobId,
    batchIdRef: { current: null },
    qboCustomerIdToHhId,
    qboInvoiceIdToHhId,
  };
}
