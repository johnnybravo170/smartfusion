/**
 * QBO Payment → HeyHenry `payments` import.
 *
 * QBO Payments are flexible: one payment may apply across multiple
 * invoices via `Line[].LinkedTxn[]`. HeyHenry's payments table holds
 * one row per (invoice, payment) — so a multi-invoice QBO Payment
 * expands into multiple HH rows.
 *
 * Method mapping (QBO PaymentMethodRef.name → HH enum):
 *   - 'Cash'                → 'cash'
 *   - 'Check' / 'Cheque'    → 'cheque'
 *   - 'Credit Card' / 'CC'  → 'credit_card'
 *   - Stripe / Square / etc → 'stripe' (Stripe is the only platform-
 *                              wired processor today)
 *   - Other / unknown / missing → 'other'
 *
 * Idempotency on (tenant_id, qbo_payment_id). Re-running updates the
 * existing row. A multi-invoice QBO Payment that gets re-imported
 * matches the FIRST HH row (qbo_payment_id is unique per tenant); the
 * sibling rows can't reuse the same qbo_payment_id due to the unique
 * partial index. We rely on the import_batch_id rollback path if a
 * QBO Payment splits in a way we mis-mapped — re-running after fixing
 * is safe because the partial unique index only fires on non-null.
 */

import type { QboPayment } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

type PaymentMethod = 'cash' | 'cheque' | 'e-transfer' | 'stripe' | 'credit_card' | 'other';

export function mapPaymentMethod(qboMethodName: string | null | undefined): PaymentMethod {
  if (!qboMethodName) return 'other';
  const n = qboMethodName.trim().toLowerCase();
  if (n === 'cash') return 'cash';
  if (n === 'check' || n === 'cheque') return 'cheque';
  if (n === 'credit card' || n === 'cc' || n.includes('credit')) return 'credit_card';
  if (n.includes('stripe') || n.includes('square') || n.includes('online')) return 'stripe';
  if (n.includes('e-transfer') || n.includes('etransfer') || n.includes('eft')) return 'e-transfer';
  return 'other';
}

export type MappedPaymentApplication = {
  qbo_invoice_id: string;
  amount_cents: number;
};

/**
 * Pull every `LinkedTxn` of type Invoice out of a QBO Payment, with
 * the per-line amount. A single QBO Payment may apply to multiple
 * invoices (or none — unapplied credits, which we skip).
 */
export function extractInvoiceApplications(qbo: QboPayment): MappedPaymentApplication[] {
  const out: MappedPaymentApplication[] = [];
  for (const line of qbo.Line ?? []) {
    if (!line.LinkedTxn) continue;
    const amount = line.Amount ?? 0;
    for (const link of line.LinkedTxn) {
      if (link.TxnType !== 'Invoice') continue;
      out.push({
        qbo_invoice_id: link.TxnId,
        amount_cents: Math.round(amount * 100),
      });
    }
  }
  return out;
}

type PaymentImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  qboCustomerIdToHhId: Map<string, string>;
  qboInvoiceIdToHhId: Map<string, string>;
  qboPaymentIdToHhId: Map<string, string>;
};

async function ensurePaymentBatch(ctx: PaymentImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'payments',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create payment import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'payments', id);
  return id;
}

export async function importPaymentPage(
  ctx: PaymentImportContext,
  page: QboPayment[],
): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  type InsertRow = {
    qbo_payment_id: string;
    qbo_sync_token: string;
    customer_id: string | null;
    invoice_id: string;
    amount_cents: number;
    method: PaymentMethod;
    payment_reference: string | null;
    payment_notes: string | null;
    paid_at: string;
  };
  const toInsert: InsertRow[] = [];
  let skipped = 0;

  for (const qbo of page) {
    // Already imported? Just touch the sync token + status.
    const existingHhId = ctx.qboPaymentIdToHhId.get(qbo.Id);
    if (existingHhId) {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from('payments')
        .update({
          qbo_sync_token: qbo.SyncToken,
          qbo_sync_status: 'synced',
          qbo_synced_at: now,
          updated_at: now,
        })
        .eq('id', existingHhId);
      if (error) throw new Error(`Failed to update payment ${existingHhId}: ${error.message}`);
      continue;
    }

    const applications = extractInvoiceApplications(qbo);
    if (applications.length === 0) {
      // Unapplied credit — no invoice to link. Skip; HH's payment
      // model requires an invoice_id.
      skipped += 1;
      continue;
    }

    const customerId = ctx.qboCustomerIdToHhId.get(qbo.CustomerRef.value) ?? null;
    const method = mapPaymentMethod(qbo.PaymentMethodRef?.name);
    const paidAt = qbo.TxnDate ? new Date(qbo.TxnDate).toISOString() : new Date().toISOString();

    let appliedAtLeastOne = false;
    for (const app of applications) {
      const invoiceId = ctx.qboInvoiceIdToHhId.get(app.qbo_invoice_id);
      if (!invoiceId) {
        skipped += 1;
        continue;
      }
      toInsert.push({
        // First applied row carries qbo_payment_id; siblings get NULL
        // so the unique partial index doesn't fire. Idempotency on
        // re-import is preserved via the first row.
        qbo_payment_id: appliedAtLeastOne ? '' : qbo.Id,
        qbo_sync_token: qbo.SyncToken,
        customer_id: customerId,
        invoice_id: invoiceId,
        amount_cents: app.amount_cents,
        method,
        payment_reference: qbo.PaymentRefNum?.trim() || null,
        payment_notes: qbo.PrivateNote?.trim() || null,
        paid_at: paidAt,
      });
      appliedAtLeastOne = true;
    }
    if (!appliedAtLeastOne) {
      // None of the linked invoices existed in HH — count the whole
      // QBO payment as skipped.
      skipped += 1;
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensurePaymentBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      invoice_id: r.invoice_id,
      customer_id: r.customer_id,
      amount_cents: r.amount_cents,
      method: r.method,
      payment_reference: r.payment_reference,
      payment_notes: r.payment_notes,
      paid_at: r.paid_at,
      // Only the first sibling row carries the qbo id; '' sentinel
      // means "no qbo id" and is converted to NULL.
      qbo_payment_id: r.qbo_payment_id || null,
      qbo_sync_token: r.qbo_payment_id ? r.qbo_sync_token : null,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('payments')
      .insert(rows)
      .select('id, qbo_payment_id');
    if (error) {
      throw new Error(`Failed to insert payments page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_payment_id: string | null }).qbo_payment_id;
      if (qboId) ctx.qboPaymentIdToHhId.set(qboId, id);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Payment', {
    fetched: page.length,
    imported: toInsert.length,
    skipped,
  });
}

export async function loadPaymentImportContext(
  tenantId: string,
  jobId: string,
): Promise<PaymentImportContext> {
  const supabase = createAdminClient();
  const [customerRes, invoiceRes, paymentRes] = await Promise.all([
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
    supabase
      .from('payments')
      .select('id, qbo_payment_id')
      .eq('tenant_id', tenantId)
      .not('qbo_payment_id', 'is', null),
  ]);

  if (customerRes.error) {
    throw new Error(`Failed to load customer round-trip map: ${customerRes.error.message}`);
  }
  if (invoiceRes.error) {
    throw new Error(`Failed to load invoice round-trip map: ${invoiceRes.error.message}`);
  }
  if (paymentRes.error) {
    throw new Error(`Failed to load payment round-trip map: ${paymentRes.error.message}`);
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
  const qboPaymentIdToHhId = new Map<string, string>();
  for (const row of paymentRes.data ?? []) {
    const r = row as { id: string; qbo_payment_id: string | null };
    if (r.qbo_payment_id) qboPaymentIdToHhId.set(r.qbo_payment_id, r.id);
  }
  return {
    tenantId,
    jobId,
    batchIdRef: { current: null },
    qboCustomerIdToHhId,
    qboInvoiceIdToHhId,
    qboPaymentIdToHhId,
  };
}
