/**
 * QBO Bill → HeyHenry `bills` + `bill_line_items` import.
 *
 * Bills are vendor invoices we owe. Read-only in HH V1 — there's no
 * native bill entry UI; new bills get entered in QBO and round-trip
 * here. The schema captures full QBO BillLine detail (account-based
 * vs item-based) so analytics can answer "what did we spend with
 * Home Depot on project X" without going back to QBO.
 *
 * Pipeline per bill:
 *   1. Resolve vendor FK via the `qbo_customer_id` map (vendors share
 *      the `customers` table).
 *   2. Idempotency on (tenant_id, qbo_bill_id).
 *   3. Money math frozen at QBO values.
 *   4. Each QBO BillLine becomes one `bill_line_items` row, preserving
 *      detail_type (account vs item) + QBO refs for class / customer /
 *      tax_code / line id.
 *
 * Bills without a resolved vendor are counted as `skipped` — the
 * vendor was probably not imported yet, or got de-duped against
 * something else. Re-run after fixing.
 */

import type { QboBill, QboBillLine } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

type BillStatus = 'open' | 'partial' | 'paid' | 'void';

export function mapQboBillToHeader(qbo: QboBill): {
  qbo_vendor_id: string;
  row: {
    doc_number: string | null;
    txn_date: string;
    due_date: string | null;
    subtotal_cents: number;
    tax_cents: number;
    total_cents: number;
    balance_cents: number;
    status: BillStatus;
    memo: string | null;
    private_note: string | null;
  };
} {
  const totalAmt = qbo.TotalAmt ?? 0;
  const totalTax = qbo.TxnTaxDetail?.TotalTax ?? 0;
  const balance = qbo.Balance ?? 0;

  const totalCents = Math.round(totalAmt * 100);
  const taxCents = Math.round(totalTax * 100);
  const subtotalCents = Math.max(totalCents - taxCents, 0);
  const balanceCents = Math.round(balance * 100);

  const status: BillStatus =
    balanceCents <= 0 ? 'paid' : balanceCents >= totalCents ? 'open' : 'partial';

  return {
    qbo_vendor_id: qbo.VendorRef.value,
    row: {
      doc_number: qbo.DocNumber?.trim() || null,
      txn_date: qbo.TxnDate ?? new Date().toISOString().slice(0, 10),
      due_date: qbo.DueDate ?? null,
      subtotal_cents: subtotalCents,
      tax_cents: taxCents,
      total_cents: totalCents,
      balance_cents: balanceCents,
      status,
      memo: null,
      private_note: qbo.PrivateNote?.trim() || null,
    },
  };
}

export function mapQboBillLines(lines: QboBillLine[]): Array<{
  position: number;
  description: string | null;
  amount_cents: number;
  detail_type: 'account' | 'item' | null;
  qbo_account_id: string | null;
  qbo_account_name: string | null;
  qbo_item_id: string | null;
  qbo_tax_code_id: string | null;
  tax_cents: number;
  qbo_line_id: string | null;
  qbo_class_id: string | null;
  qbo_customer_ref: string | null;
}> {
  const out: ReturnType<typeof mapQboBillLines> = [];
  lines.forEach((line, idx) => {
    const accountDetail = line.AccountBasedExpenseLineDetail;
    const itemDetail = line.ItemBasedExpenseLineDetail;
    const detailType: 'account' | 'item' | null = accountDetail
      ? 'account'
      : itemDetail
        ? 'item'
        : null;
    out.push({
      position: idx,
      description: line.Description?.trim() || null,
      amount_cents: Math.round((line.Amount ?? 0) * 100),
      detail_type: detailType,
      qbo_account_id: accountDetail?.AccountRef?.value ?? null,
      qbo_account_name: accountDetail?.AccountRef?.name ?? null,
      qbo_item_id: itemDetail?.ItemRef?.value ?? null,
      qbo_tax_code_id: accountDetail?.TaxCodeRef?.value ?? itemDetail?.TaxCodeRef?.value ?? null,
      tax_cents: 0, // Per-line tax isn't itemized on bills the way it is on invoices.
      qbo_line_id: line.Id ?? null,
      qbo_class_id: accountDetail?.ClassRef?.value ?? itemDetail?.ClassRef?.value ?? null,
      qbo_customer_ref: accountDetail?.CustomerRef?.value ?? itemDetail?.CustomerRef?.value ?? null,
    });
  });
  return out;
}

type BillImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  qboVendorIdToHhId: Map<string, string>;
  qboBillIdToHhId: Map<string, string>;
};

async function ensureBillBatch(ctx: BillImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'bills',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create bill import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'bills', id);
  return id;
}

export async function importBillPage(ctx: BillImportContext, page: QboBill[]): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  type Insert = {
    qbo: QboBill;
    qbo_bill_id: string;
    qbo_sync_token: string;
    vendor_id: string;
    header: ReturnType<typeof mapQboBillToHeader>['row'];
  };
  type Update = {
    id: string;
    qbo: QboBill;
    header: ReturnType<typeof mapQboBillToHeader>['row'];
  };
  const toInsert: Insert[] = [];
  const toUpdate: Update[] = [];
  let skipped = 0;

  for (const qbo of page) {
    const { qbo_vendor_id, row } = mapQboBillToHeader(qbo);
    const vendorId = ctx.qboVendorIdToHhId.get(qbo_vendor_id);
    if (!vendorId) {
      skipped += 1;
      continue;
    }
    const existingHhId = ctx.qboBillIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo, header: row });
    } else {
      toInsert.push({
        qbo,
        qbo_bill_id: qbo.Id,
        qbo_sync_token: qbo.SyncToken,
        vendor_id: vendorId,
        header: row,
      });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensureBillBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      vendor_id: r.vendor_id,
      doc_number: r.header.doc_number,
      txn_date: r.header.txn_date,
      due_date: r.header.due_date,
      subtotal_cents: r.header.subtotal_cents,
      tax_cents: r.header.tax_cents,
      total_cents: r.header.total_cents,
      balance_cents: r.header.balance_cents,
      status: r.header.status,
      memo: r.header.memo,
      private_note: r.header.private_note,
      qbo_bill_id: r.qbo_bill_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('bills')
      .insert(rows)
      .select('id, qbo_bill_id');
    if (error) {
      throw new Error(`Failed to insert bills page: ${error.message}`);
    }

    // Insert child lines for each newly-inserted bill.
    const lineRowsToInsert: Array<Record<string, unknown>> = [];
    for (const r of inserted ?? []) {
      const billId = (r as { id: string }).id;
      const qboBillId = (r as { qbo_bill_id: string | null }).qbo_bill_id;
      const sourceBill = toInsert.find((i) => i.qbo_bill_id === qboBillId);
      if (!sourceBill || !qboBillId) continue;
      ctx.qboBillIdToHhId.set(qboBillId, billId);
      const lines = mapQboBillLines(sourceBill.qbo.Line ?? []);
      for (const line of lines) {
        lineRowsToInsert.push({
          bill_id: billId,
          tenant_id: ctx.tenantId,
          position: line.position,
          description: line.description,
          amount_cents: line.amount_cents,
          detail_type: line.detail_type,
          qbo_account_id: line.qbo_account_id,
          qbo_account_name: line.qbo_account_name,
          qbo_item_id: line.qbo_item_id,
          qbo_tax_code_id: line.qbo_tax_code_id,
          tax_cents: line.tax_cents,
          qbo_line_id: line.qbo_line_id,
          qbo_class_id: line.qbo_class_id,
          qbo_customer_ref: line.qbo_customer_ref,
        });
      }
    }
    if (lineRowsToInsert.length > 0) {
      const { error: lineErr } = await supabase.from('bill_line_items').insert(lineRowsToInsert);
      if (lineErr) {
        throw new Error(`Failed to insert bill_line_items: ${lineErr.message}`);
      }
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('bills')
      .update({
        doc_number: u.header.doc_number,
        txn_date: u.header.txn_date,
        due_date: u.header.due_date,
        subtotal_cents: u.header.subtotal_cents,
        tax_cents: u.header.tax_cents,
        total_cents: u.header.total_cents,
        balance_cents: u.header.balance_cents,
        status: u.header.status,
        private_note: u.header.private_note,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update bill ${u.id}: ${error.message}`);
    }
    // Replace line items wholesale — QBO is source of truth on re-import.
    await supabase.from('bill_line_items').delete().eq('bill_id', u.id);
    const lines = mapQboBillLines(u.qbo.Line ?? []);
    if (lines.length > 0) {
      const lineRows = lines.map((line) => ({
        bill_id: u.id,
        tenant_id: ctx.tenantId,
        position: line.position,
        description: line.description,
        amount_cents: line.amount_cents,
        detail_type: line.detail_type,
        qbo_account_id: line.qbo_account_id,
        qbo_account_name: line.qbo_account_name,
        qbo_item_id: line.qbo_item_id,
        qbo_tax_code_id: line.qbo_tax_code_id,
        tax_cents: line.tax_cents,
        qbo_line_id: line.qbo_line_id,
        qbo_class_id: line.qbo_class_id,
        qbo_customer_ref: line.qbo_customer_ref,
      }));
      const { error: lineErr } = await supabase.from('bill_line_items').insert(lineRows);
      if (lineErr) {
        throw new Error(`Failed to re-insert bill_line_items for ${u.id}: ${lineErr.message}`);
      }
    }
  }

  await bumpJobProgress(ctx.jobId, 'Bill', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped,
  });
}

export async function loadBillImportContext(
  tenantId: string,
  jobId: string,
): Promise<BillImportContext> {
  const supabase = createAdminClient();
  const [vendorRes, billRes] = await Promise.all([
    supabase
      .from('customers')
      .select('id, qbo_customer_id')
      .eq('tenant_id', tenantId)
      .eq('kind', 'vendor')
      .not('qbo_customer_id', 'is', null)
      .is('deleted_at', null),
    supabase
      .from('bills')
      .select('id, qbo_bill_id')
      .eq('tenant_id', tenantId)
      .not('qbo_bill_id', 'is', null),
  ]);

  if (vendorRes.error) {
    throw new Error(`Failed to load vendor round-trip map: ${vendorRes.error.message}`);
  }
  if (billRes.error) {
    throw new Error(`Failed to load bill round-trip map: ${billRes.error.message}`);
  }

  const qboVendorIdToHhId = new Map<string, string>();
  for (const row of vendorRes.data ?? []) {
    const r = row as { id: string; qbo_customer_id: string | null };
    if (r.qbo_customer_id) qboVendorIdToHhId.set(r.qbo_customer_id, r.id);
  }
  const qboBillIdToHhId = new Map<string, string>();
  for (const row of billRes.data ?? []) {
    const r = row as { id: string; qbo_bill_id: string | null };
    if (r.qbo_bill_id) qboBillIdToHhId.set(r.qbo_bill_id, r.id);
  }
  return { tenantId, jobId, batchIdRef: { current: null }, qboVendorIdToHhId, qboBillIdToHhId };
}
