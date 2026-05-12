import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerInvoiceStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'paid';

export type WorkerInvoiceRow = {
  id: string;
  tenant_id: string;
  worker_profile_id: string;
  project_id: string | null;
  project_name: string | null;
  worker_name: string | null;
  status: WorkerInvoiceStatus;
  period_start: string;
  period_end: string;
  subtotal_cents: number;
  tax_rate: number;
  tax_cents: number;
  total_cents: number;
  notes: string | null;
  rejection_reason: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  paid_at: string | null;
  created_at: string;
};

export type InvoiceTimeLine = {
  id: string;
  entry_date: string;
  hours: number;
  charge_rate_cents: number | null;
  amount_cents: number;
  project_name: string | null;
  budget_category_name: string | null;
  notes: string | null;
};

export type InvoiceExpenseLine = {
  id: string;
  expense_date: string;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  project_name: string | null;
  receipt_storage_path: string | null;
};

type RawInvoice = Record<string, unknown>;

function mapInvoice(r: RawInvoice): WorkerInvoiceRow {
  const project = r.projects as { name?: string } | { name?: string }[] | null;
  const worker = r.worker_profiles as
    | { display_name?: string | null }
    | { display_name?: string | null }[]
    | null;
  const proj = Array.isArray(project) ? project[0] : project;
  const wp = Array.isArray(worker) ? worker[0] : worker;
  return {
    id: r.id as string,
    tenant_id: r.tenant_id as string,
    worker_profile_id: r.worker_profile_id as string,
    project_id: (r.project_id as string | null) ?? null,
    project_name: proj?.name ?? null,
    worker_name: wp?.display_name ?? null,
    status: r.status as WorkerInvoiceStatus,
    period_start: r.period_start as string,
    period_end: r.period_end as string,
    subtotal_cents: Number(r.subtotal_cents),
    tax_rate: Number(r.tax_rate),
    tax_cents: Number(r.tax_cents),
    total_cents: Number(r.total_cents),
    notes: (r.notes as string | null) ?? null,
    rejection_reason: (r.rejection_reason as string | null) ?? null,
    submitted_at: (r.submitted_at as string | null) ?? null,
    approved_at: (r.approved_at as string | null) ?? null,
    paid_at: (r.paid_at as string | null) ?? null,
    created_at: r.created_at as string,
  };
}

const SELECT =
  'id, tenant_id, worker_profile_id, project_id, status, period_start, period_end, subtotal_cents, tax_rate, tax_cents, total_cents, notes, rejection_reason, submitted_at, approved_at, paid_at, created_at, projects:project_id (name), worker_profiles:worker_profile_id (display_name)';

export async function listInvoicesForWorker(
  tenantId: string,
  workerProfileId: string,
): Promise<WorkerInvoiceRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_invoices')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawInvoice[]).map(mapInvoice);
}

export async function listInvoicesForProject(
  tenantId: string,
  projectId: string,
): Promise<WorkerInvoiceRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_invoices')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .eq('project_id', projectId)
    .neq('status', 'draft')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as RawInvoice[]).map(mapInvoice);
}

export async function getInvoice(
  tenantId: string,
  invoiceId: string,
): Promise<WorkerInvoiceRow | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('worker_invoices')
    .select(SELECT)
    .eq('tenant_id', tenantId)
    .eq('id', invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? mapInvoice(data as unknown as RawInvoice) : null;
}

export async function getInvoiceLines(
  tenantId: string,
  invoiceId: string,
): Promise<{ time: InvoiceTimeLine[]; expenses: InvoiceExpenseLine[] }> {
  const admin = createAdminClient();
  const [{ data: timeRows }, { data: expRows }] = await Promise.all([
    admin
      .from('time_entries')
      .select(
        'id, entry_date, hours, charge_rate_cents, notes, projects:project_id (name), project_budget_categories:budget_category_id (name)',
      )
      .eq('tenant_id', tenantId)
      .eq('worker_invoice_id', invoiceId)
      .order('entry_date', { ascending: true }),
    // Worker receipts only — vendor bills don't flow through worker
    // invoices. Reads from the unified project_costs table; the field
    // names below are remapped in the result builder to keep the
    // output shape stable for callers.
    admin
      .from('project_costs')
      .select(
        'id, cost_date, amount_cents, vendor, description, attachment_storage_path, projects:project_id (name)',
      )
      .eq('tenant_id', tenantId)
      .eq('source_type', 'receipt')
      .eq('status', 'active')
      .eq('worker_invoice_id', invoiceId)
      .order('cost_date', { ascending: true }),
  ]);

  const time = ((timeRows ?? []) as unknown as RawInvoice[]).map((r) => {
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const buck = r.project_budget_categories as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const b = Array.isArray(buck) ? buck[0] : buck;
    const hours = Number(r.hours);
    const rate = (r.charge_rate_cents as number | null) ?? null;
    return {
      id: r.id as string,
      entry_date: r.entry_date as string,
      hours,
      charge_rate_cents: rate,
      amount_cents: rate ? Math.round(hours * rate) : 0,
      project_name: p?.name ?? null,
      budget_category_name: b?.name ?? null,
      notes: (r.notes as string | null) ?? null,
    };
  });

  const expenses = ((expRows ?? []) as unknown as RawInvoice[]).map((r) => {
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const row = r as unknown as Record<string, unknown>;
    return {
      id: r.id as string,
      expense_date: (row.cost_date as string | undefined) ?? (r.expense_date as string),
      amount_cents: Number(r.amount_cents),
      vendor: (r.vendor as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      project_name: p?.name ?? null,
      receipt_storage_path:
        (row.attachment_storage_path as string | null | undefined) ??
        null ??
        (row.receipt_storage_path as string | null | undefined) ??
        null,
    };
  });

  return { time, expenses };
}

/** Preview unbilled time + expenses for a worker across a date range + optional project filter. */
export async function previewUnbilledForWorker(args: {
  tenantId: string;
  workerProfileId: string;
  projectId?: string | null;
  fromDate: string;
  toDate: string;
}): Promise<{ time: InvoiceTimeLine[]; expenses: InvoiceExpenseLine[] }> {
  const admin = createAdminClient();
  let timeQuery = admin
    .from('time_entries')
    .select(
      'id, entry_date, hours, charge_rate_cents, notes, projects:project_id (name), project_budget_categories:budget_category_id (name)',
    )
    .eq('tenant_id', args.tenantId)
    .eq('worker_profile_id', args.workerProfileId)
    .is('worker_invoice_id', null)
    .gte('entry_date', args.fromDate)
    .lte('entry_date', args.toDate)
    .order('entry_date', { ascending: true });
  let expQuery = admin
    .from('project_costs')
    .select(
      'id, cost_date, amount_cents, vendor, description, attachment_storage_path, projects:project_id (name)',
    )
    .eq('tenant_id', args.tenantId)
    .eq('source_type', 'receipt')
    .eq('status', 'active')
    .eq('worker_profile_id', args.workerProfileId)
    .is('worker_invoice_id', null)
    .gte('cost_date', args.fromDate)
    .lte('cost_date', args.toDate)
    .order('cost_date', { ascending: true });
  if (args.projectId) {
    timeQuery = timeQuery.eq('project_id', args.projectId);
    expQuery = expQuery.eq('project_id', args.projectId);
  }
  const [{ data: timeRows }, { data: expRows }] = await Promise.all([timeQuery, expQuery]);

  const time = ((timeRows ?? []) as unknown as RawInvoice[]).map((r) => {
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const buck = r.project_budget_categories as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const b = Array.isArray(buck) ? buck[0] : buck;
    const hours = Number(r.hours);
    const rate = (r.charge_rate_cents as number | null) ?? null;
    return {
      id: r.id as string,
      entry_date: r.entry_date as string,
      hours,
      charge_rate_cents: rate,
      amount_cents: rate ? Math.round(hours * rate) : 0,
      project_name: p?.name ?? null,
      budget_category_name: b?.name ?? null,
      notes: (r.notes as string | null) ?? null,
    };
  });

  const expenses = ((expRows ?? []) as unknown as RawInvoice[]).map((r) => {
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const row = r as unknown as Record<string, unknown>;
    return {
      id: r.id as string,
      expense_date: (row.cost_date as string | undefined) ?? (r.expense_date as string),
      amount_cents: Number(r.amount_cents),
      vendor: (r.vendor as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      project_name: p?.name ?? null,
      receipt_storage_path:
        (row.attachment_storage_path as string | null | undefined) ??
        null ??
        (row.receipt_storage_path as string | null | undefined) ??
        null,
    };
  });

  return { time, expenses };
}
