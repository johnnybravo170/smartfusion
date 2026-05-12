/**
 * Dual-write shim: mirror every write to `expenses` and `project_bills`
 * into the unified `project_costs` table.
 *
 * Lives only during the cost-unification rollout. Once all read paths
 * are cut over to `project_costs` and we stop writing to the legacy
 * tables, this shim (and its callers) get deleted.
 *
 * Design notes:
 *
 * - Mirror functions read the freshly-written source row by id and
 *   upsert into `project_costs` using the same id. Field mapping is
 *   centralized here (not at the call sites) so adding a column to the
 *   source schema only requires a change in one place.
 *
 * - `safeMirror*` helpers swallow failures and log them. The user's
 *   action succeeds even if the mirror write fails; drift is
 *   recoverable by re-running the backfill against orphan ids. This
 *   trade-off favors uptime — a buggy mirror should never block an
 *   expense entry.
 *
 * - Call sites that want hard failure can call the bare `mirror*`
 *   variant directly.
 */

// The codebase passes around bare untyped Supabase clients (no generated
// `Database` type lives in src/), so the shim accepts both server and
// admin client shapes via structural typing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

type ExpenseRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  project_id: string | null;
  budget_category_id: string | null;
  cost_line_id: string | null;
  category_id: string | null;
  job_id: string | null;
  amount_cents: number;
  pre_tax_amount_cents: number | null;
  tax_cents: number;
  vendor: string | null;
  vendor_gst_number: string | null;
  description: string | null;
  receipt_url: string | null;
  receipt_storage_path: string | null;
  expense_date: string;
  created_at: string;
  updated_at: string;
  worker_profile_id: string | null;
  worker_invoice_id: string | null;
  recurring_rule_id: string | null;
  import_batch_id: string | null;
  payment_source_id: string | null;
  card_last4: string | null;
  qbo_purchase_id: string | null;
  qbo_sync_token: string | null;
  qbo_sync_status: string | null;
  qbo_synced_at: string | null;
};

type BillRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  vendor: string;
  bill_date: string;
  description: string | null;
  amount_cents: number; // pre-GST (per migration 0083)
  status: 'pending' | 'approved' | 'paid';
  receipt_url: string | null;
  cost_code: string | null;
  created_at: string;
  updated_at: string;
  inbound_email_id: string | null;
  budget_category_id: string | null;
  gst_cents: number;
  attachment_storage_path: string | null;
  vendor_gst_number: string | null;
  cost_line_id: string | null;
};

export function expenseRowToProjectCost(row: ExpenseRow) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    user_id: row.user_id,
    source_type: 'receipt' as const,
    // Receipts are implicitly paid at entry time.
    payment_status: 'paid' as const,
    paid_at: row.created_at,
    status: 'active' as const,
    vendor: row.vendor,
    vendor_gst_number: row.vendor_gst_number,
    description: row.description,
    cost_date: row.expense_date,
    // expenses.amount_cents is gross (incl. GST). pre_tax_amount_cents
    // is nullable for legacy rows without OCR breakdown.
    amount_cents: row.amount_cents,
    pre_tax_amount_cents: row.pre_tax_amount_cents,
    gst_cents: row.tax_cents,
    budget_category_id: row.budget_category_id,
    cost_line_id: row.cost_line_id,
    category_id: row.category_id,
    job_id: row.job_id,
    attachment_storage_path: row.receipt_storage_path,
    receipt_url: row.receipt_url,
    worker_profile_id: row.worker_profile_id,
    worker_invoice_id: row.worker_invoice_id,
    import_batch_id: row.import_batch_id,
    recurring_rule_id: row.recurring_rule_id,
    payment_source_id: row.payment_source_id,
    card_last4: row.card_last4,
    qbo_purchase_id: row.qbo_purchase_id,
    qbo_sync_token: row.qbo_sync_token,
    qbo_sync_status: row.qbo_sync_status,
    qbo_synced_at: row.qbo_synced_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function billRowToProjectCost(row: BillRow) {
  const isPaid = row.status === 'paid';
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    user_id: null,
    source_type: 'vendor_bill' as const,
    payment_status: (isPaid ? 'paid' : 'unpaid') as 'paid' | 'unpaid',
    // No paid_at column on project_bills — updated_at is the best
    // legacy signal for "when this got marked paid".
    paid_at: isPaid ? row.updated_at : null,
    status: 'active' as const,
    vendor: row.vendor,
    vendor_gst_number: row.vendor_gst_number,
    description: row.description,
    cost_date: row.bill_date,
    // project_bills.amount_cents is pre-GST (per migration 0083).
    // project_costs.amount_cents is gross, so add gst_cents.
    amount_cents: row.amount_cents + row.gst_cents,
    pre_tax_amount_cents: row.amount_cents,
    gst_cents: row.gst_cents,
    budget_category_id: row.budget_category_id,
    cost_line_id: row.cost_line_id,
    attachment_storage_path: row.attachment_storage_path,
    receipt_url: row.receipt_url,
    inbound_email_id: row.inbound_email_id,
    external_ref: row.cost_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function readExpense(client: AnyClient, id: string): Promise<ExpenseRow> {
  const { data, error } = await client.from('expenses').select('*').eq('id', id).single();
  if (error || !data) {
    throw new Error(
      `project-costs-shim: failed to read expenses ${id}: ${error?.message ?? 'not found'}`,
    );
  }
  return data as ExpenseRow;
}

async function readBill(client: AnyClient, id: string): Promise<BillRow> {
  const { data, error } = await client.from('project_bills').select('*').eq('id', id).single();
  if (error || !data) {
    throw new Error(
      `project-costs-shim: failed to read project_bills ${id}: ${error?.message ?? 'not found'}`,
    );
  }
  return data as BillRow;
}

async function upsertCost(client: AnyClient, row: Record<string, unknown>): Promise<void> {
  const { error } = await client.from('project_costs').upsert(row, { onConflict: 'id' });
  if (error) {
    throw new Error(
      `project-costs-shim: failed to upsert project_costs ${row.id}: ${error.message}`,
    );
  }
}

export async function mirrorExpense(client: AnyClient, id: string): Promise<void> {
  await upsertCost(client, expenseRowToProjectCost(await readExpense(client, id)));
}

export async function mirrorBill(client: AnyClient, id: string): Promise<void> {
  await upsertCost(client, billRowToProjectCost(await readBill(client, id)));
}

export async function mirrorExpenses(client: AnyClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await client
    .from('expenses')
    .select('*')
    .in('id', ids as string[]);
  if (error) {
    throw new Error(`project-costs-shim: failed to read expenses batch: ${error.message}`);
  }
  if (!data?.length) return;
  const rows = (data as ExpenseRow[]).map(expenseRowToProjectCost);
  const { error: upErr } = await client.from('project_costs').upsert(rows, { onConflict: 'id' });
  if (upErr) {
    throw new Error(`project-costs-shim: failed to upsert project_costs batch: ${upErr.message}`);
  }
}

export async function mirrorBills(client: AnyClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { data, error } = await client
    .from('project_bills')
    .select('*')
    .in('id', ids as string[]);
  if (error) {
    throw new Error(`project-costs-shim: failed to read bills batch: ${error.message}`);
  }
  if (!data?.length) return;
  const rows = (data as BillRow[]).map(billRowToProjectCost);
  const { error: upErr } = await client.from('project_costs').upsert(rows, { onConflict: 'id' });
  if (upErr) {
    throw new Error(`project-costs-shim: failed to upsert project_costs batch: ${upErr.message}`);
  }
}

export async function unmirrorCost(client: AnyClient, id: string): Promise<void> {
  const { error } = await client.from('project_costs').delete().eq('id', id);
  if (error) {
    throw new Error(`project-costs-shim: failed to delete project_costs ${id}: ${error.message}`);
  }
}

export async function unmirrorCosts(client: AnyClient, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await client
    .from('project_costs')
    .delete()
    .in('id', ids as string[]);
  if (error) {
    throw new Error(`project-costs-shim: failed to delete project_costs batch: ${error.message}`);
  }
}

// --- Safe variants ---------------------------------------------------------
// Log and continue. Use these from server actions where the user-visible
// write must not fail just because the mirror failed.

function log(scope: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[project-costs-shim] ${scope}`, err);
}

export async function safeMirrorExpense(client: AnyClient, id: string): Promise<void> {
  try {
    await mirrorExpense(client, id);
  } catch (e) {
    log(`mirrorExpense(${id})`, e);
  }
}

export async function safeMirrorBill(client: AnyClient, id: string): Promise<void> {
  try {
    await mirrorBill(client, id);
  } catch (e) {
    log(`mirrorBill(${id})`, e);
  }
}

export async function safeMirrorExpenses(client: AnyClient, ids: readonly string[]): Promise<void> {
  try {
    await mirrorExpenses(client, ids);
  } catch (e) {
    log(`mirrorExpenses(n=${ids.length})`, e);
  }
}

export async function safeMirrorBills(client: AnyClient, ids: readonly string[]): Promise<void> {
  try {
    await mirrorBills(client, ids);
  } catch (e) {
    log(`mirrorBills(n=${ids.length})`, e);
  }
}

export async function safeUnmirrorCost(client: AnyClient, id: string): Promise<void> {
  try {
    await unmirrorCost(client, id);
  } catch (e) {
    log(`unmirrorCost(${id})`, e);
  }
}

export async function safeUnmirrorCosts(client: AnyClient, ids: readonly string[]): Promise<void> {
  try {
    await unmirrorCosts(client, ids);
  } catch (e) {
    log(`unmirrorCosts(n=${ids.length})`, e);
  }
}
