/**
 * GST/HST remittance report.
 *
 * Purpose: at filing time (monthly / quarterly / annual), a contractor
 * or their bookkeeper needs ONE screen showing:
 *   - Total GST/HST collected on invoices → how much we owe the CRA
 *   - Total GST/HST paid on expenses + bills (Input Tax Credits) →
 *     how much we get to deduct
 *   - Net owed (or refund owed to us)
 *   - Whether we've already filed + paid for this period
 *
 * Two breakdown dimensions on the ITC side:
 *   - paid_overhead — grouped by category (fuel, tools, office, etc.)
 *   - paid_project_work — grouped by project (expenses + bills combined
 *     per project so the bookkeeper can audit "how much tax did we
 *     pay running the Smith Kitchen job")
 *
 * Scope decisions carried over from V1:
 *   - GST/HST ONLY. PST/QST are not ITC-eligible.
 *   - Invoices count when paid (status = 'paid', paid_at in range).
 *   - Expenses + bills count when dated in range (cost_date) regardless
 *     of whether the bill is marked paid.
 *   - Admin client because bookkeepers will need cross-surface access.
 *
 * As of the cost-unification rollout the ITC side reads from the
 * unified `project_costs` table, splitting receipts vs vendor bills via
 * the `source_type` discriminator. Byte-identical to the legacy two-
 * query implementation: receipts expose gross `amount_cents` + GST in
 * `gst_cents` (which carries `expenses.tax_cents` verbatim); bills
 * expose pre-GST `amount_cents` (read from `pre_tax_amount_cents`,
 * which the backfill copied verbatim from `project_bills.amount_cents`)
 * + GST in `gst_cents`.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type RemittancePeriod = {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD (inclusive)
};

export type RemittanceCategoryLine = {
  category_id: string | null;
  category_label: string;
  tax_cents: number;
  amount_cents: number;
};

export type RemittanceProjectLine = {
  project_id: string;
  project_name: string;
  expense_count: number;
  bill_count: number;
  tax_cents: number;
  amount_cents: number;
};

export type FiledRemittance = {
  id: string;
  paid_at: string;
  amount_cents: number;
  reference: string | null;
  notes: string | null;
};

export type MissingBnFlag = {
  /** "expense" or "bill" — lets the UI link to the right edit surface. */
  kind: 'expense' | 'bill';
  id: string;
  vendor: string | null;
  amount_cents: number;
  tax_cents: number;
  date: string;
  project_id: string | null;
  project_name: string | null;
};

export type GstRemittanceReport = {
  period: RemittancePeriod;
  collected: {
    invoice_count: number;
    tax_cents: number;
    amount_cents: number;
  };
  paid_overhead: {
    count: number;
    tax_cents: number;
    amount_cents: number;
    by_category: RemittanceCategoryLine[];
  };
  paid_project_work: {
    expense_count: number;
    bill_count: number;
    tax_cents: number;
    amount_cents: number;
    by_project: RemittanceProjectLine[];
  };
  net_owed_cents: number;
  /** If this exact period has been marked paid, the filed record. Else null. */
  filed: FiledRemittance | null;
  /**
   * Expenses + bills over $30 with GST claimed but the vendor's BN not
   * captured. CRA can disallow the ITC on these — the bookkeeper needs
   * to chase down the BN before filing.
   */
  missing_bn: MissingBnFlag[];
};

export async function getGstRemittanceReport(
  tenantId: string,
  period: RemittancePeriod,
): Promise<GstRemittanceReport> {
  const admin = createAdminClient();

  const [invoicesRes, costsRes, categoriesRes, projectsRes, filedRes] = await Promise.all([
    admin
      .from('invoices')
      .select('amount_cents, tax_cents')
      .eq('tenant_id', tenantId)
      .eq('status', 'paid')
      .gte('paid_at', period.from)
      .lte('paid_at', `${period.to}T23:59:59.999Z`)
      .is('deleted_at', null),
    admin
      .from('project_costs')
      .select(
        'id, source_type, amount_cents, pre_tax_amount_cents, gst_cents, category_id, project_id, vendor, vendor_gst_number, cost_date',
      )
      .eq('tenant_id', tenantId)
      .eq('status', 'active')
      .gte('cost_date', period.from)
      .lte('cost_date', period.to),
    admin
      .from('expense_categories')
      .select('id, name, parent_id, parent:parent_id (name)')
      .eq('tenant_id', tenantId),
    admin.from('projects').select('id, name').eq('tenant_id', tenantId).is('deleted_at', null),
    admin
      .from('gst_remittances')
      .select('id, paid_at, amount_cents, reference, notes')
      .eq('tenant_id', tenantId)
      .eq('period_from', period.from)
      .eq('period_to', period.to)
      .maybeSingle(),
  ]);

  if (invoicesRes.error) throw new Error(`Remittance: ${invoicesRes.error.message}`);
  if (costsRes.error) throw new Error(`Remittance: ${costsRes.error.message}`);
  if (categoriesRes.error) throw new Error(`Remittance: ${categoriesRes.error.message}`);
  if (projectsRes.error) throw new Error(`Remittance: ${projectsRes.error.message}`);
  if (filedRes.error && filedRes.error.code !== 'PGRST116') {
    throw new Error(`Remittance: ${filedRes.error.message}`);
  }

  const invoices = invoicesRes.data ?? [];
  const cats = categoriesRes.data ?? [];
  const projects = projectsRes.data ?? [];

  // Reshape unified project_costs rows back to the (expense, bill) shape
  // the rest of this function consumes, preserving byte-identical
  // amount semantics (receipts gross, bills pre-GST).
  type CostRow = {
    id: string;
    source_type: 'receipt' | 'vendor_bill';
    amount_cents: number;
    pre_tax_amount_cents: number | null;
    gst_cents: number;
    category_id: string | null;
    project_id: string | null;
    vendor: string | null;
    vendor_gst_number: string | null;
    cost_date: string;
  };
  const costRows = (costsRes.data ?? []) as CostRow[];
  const expenses = costRows
    .filter((c) => c.source_type === 'receipt')
    .map((c) => ({
      id: c.id,
      amount_cents: c.amount_cents,
      tax_cents: c.gst_cents,
      category_id: c.category_id,
      project_id: c.project_id,
      vendor: c.vendor,
      vendor_gst_number: c.vendor_gst_number,
      expense_date: c.cost_date,
    }));
  const bills = costRows
    .filter((c) => c.source_type === 'vendor_bill')
    .map((c) => ({
      id: c.id,
      amount_cents: c.pre_tax_amount_cents ?? c.amount_cents,
      gst_cents: c.gst_cents,
      project_id: c.project_id,
      vendor: c.vendor,
      vendor_gst_number: c.vendor_gst_number,
      bill_date: c.cost_date,
    }));

  // Category label map (overhead side).
  const catLabel = new Map<string, string>();
  for (const c of cats) {
    const parentRaw = (c as { parent?: { name?: string } | { name?: string }[] | null }).parent;
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    const name = (c.name as string) ?? '?';
    catLabel.set(c.id as string, parent?.name ? `${parent.name} › ${name}` : name);
  }

  // Project name map.
  const projectName = new Map<string, string>();
  for (const p of projects) {
    projectName.set(p.id as string, (p.name as string) ?? 'Untitled project');
  }

  // Split expenses into overhead vs project-linked.
  const overheadExpenses = expenses.filter((e) => !e.project_id);
  const projectExpenses = expenses.filter((e) => !!e.project_id);

  // ---- OVERHEAD side: group by category ----
  type Bucket = { tax: number; amount: number };
  const overheadByCat = new Map<string | null, Bucket>();
  for (const e of overheadExpenses) {
    const cid = (e.category_id as string | null) ?? null;
    const cur = overheadByCat.get(cid) ?? { tax: 0, amount: 0 };
    cur.tax += (e.tax_cents as number) ?? 0;
    cur.amount += (e.amount_cents as number) ?? 0;
    overheadByCat.set(cid, cur);
  }
  const overheadByCategory: RemittanceCategoryLine[] = Array.from(overheadByCat.entries())
    .map(([cid, b]) => ({
      category_id: cid,
      category_label: cid ? (catLabel.get(cid) ?? 'Unknown') : 'Uncategorized',
      tax_cents: b.tax,
      amount_cents: b.amount,
    }))
    .sort((a, b) => b.tax_cents - a.tax_cents);

  // ---- PROJECT WORK side: combine project expenses + project bills, group by project ----
  type ProjectBucket = { expenses: number; billsCount: number; tax: number; amount: number };
  const byProject = new Map<string, ProjectBucket>();

  for (const e of projectExpenses) {
    const pid = e.project_id as string;
    const cur = byProject.get(pid) ?? { expenses: 0, billsCount: 0, tax: 0, amount: 0 };
    cur.expenses += 1;
    cur.tax += (e.tax_cents as number) ?? 0;
    cur.amount += (e.amount_cents as number) ?? 0;
    byProject.set(pid, cur);
  }

  for (const b of bills) {
    const pid = b.project_id as string | null;
    if (!pid) continue;
    const cur = byProject.get(pid) ?? { expenses: 0, billsCount: 0, tax: 0, amount: 0 };
    cur.billsCount += 1;
    cur.tax += (b.gst_cents as number) ?? 0;
    cur.amount += (b.amount_cents as number) ?? 0;
    byProject.set(pid, cur);
  }

  const byProjectLines: RemittanceProjectLine[] = Array.from(byProject.entries())
    .map(([pid, b]) => ({
      project_id: pid,
      project_name: projectName.get(pid) ?? '(deleted project)',
      expense_count: b.expenses,
      bill_count: b.billsCount,
      tax_cents: b.tax,
      amount_cents: b.amount,
    }))
    .sort((a, b) => b.tax_cents - a.tax_cents);

  // Totals.
  const collectedTax = invoices.reduce((s, i) => s + ((i.tax_cents as number) ?? 0), 0);
  const collectedAmount = invoices.reduce((s, i) => s + ((i.amount_cents as number) ?? 0), 0);

  const overheadTax = overheadExpenses.reduce((s, e) => s + ((e.tax_cents as number) ?? 0), 0);
  const overheadAmount = overheadExpenses.reduce(
    (s, e) => s + ((e.amount_cents as number) ?? 0),
    0,
  );

  const projectExpenseTax = projectExpenses.reduce((s, e) => s + ((e.tax_cents as number) ?? 0), 0);
  const projectExpenseAmount = projectExpenses.reduce(
    (s, e) => s + ((e.amount_cents as number) ?? 0),
    0,
  );
  const billsTax = bills.reduce((s, b) => s + ((b.gst_cents as number) ?? 0), 0);
  const billsAmount = bills.reduce((s, b) => s + ((b.amount_cents as number) ?? 0), 0);
  const projectTotalTax = projectExpenseTax + billsTax;
  const projectTotalAmount = projectExpenseAmount + billsAmount;

  const filed = filedRes.data
    ? {
        id: filedRes.data.id as string,
        paid_at: filedRes.data.paid_at as string,
        amount_cents: filedRes.data.amount_cents as number,
        reference: (filedRes.data.reference as string | null) ?? null,
        notes: (filedRes.data.notes as string | null) ?? null,
      }
    : null;

  // Missing BN flags — expenses + bills over $30 with tax claimed but
  // no vendor_gst_number. CRA's threshold is exact, not "roughly $30";
  // we use $30 gross including tax to match their rule.
  const BN_THRESHOLD_CENTS = 3000;
  const missingBn: MissingBnFlag[] = [];
  for (const e of expenses) {
    const gross = (e.amount_cents as number) ?? 0;
    const tax = (e.tax_cents as number) ?? 0;
    const bn = (e.vendor_gst_number as string | null)?.trim();
    if (gross >= BN_THRESHOLD_CENTS && tax > 0 && !bn) {
      const pid = (e.project_id as string | null) ?? null;
      missingBn.push({
        kind: 'expense',
        id: e.id as string,
        vendor: (e.vendor as string | null) ?? null,
        amount_cents: gross,
        tax_cents: tax,
        date: e.expense_date as string,
        project_id: pid,
        project_name: pid ? (projectName.get(pid) ?? null) : null,
      });
    }
  }
  for (const b of bills) {
    const gross = (b.amount_cents as number) ?? 0;
    const tax = (b.gst_cents as number) ?? 0;
    const bn = (b.vendor_gst_number as string | null)?.trim();
    if (gross >= BN_THRESHOLD_CENTS && tax > 0 && !bn) {
      const pid = (b.project_id as string | null) ?? null;
      missingBn.push({
        kind: 'bill',
        id: b.id as string,
        vendor: (b.vendor as string | null) ?? null,
        amount_cents: gross,
        tax_cents: tax,
        date: b.bill_date as string,
        project_id: pid,
        project_name: pid ? (projectName.get(pid) ?? null) : null,
      });
    }
  }
  missingBn.sort((a, b) => b.tax_cents - a.tax_cents);

  return {
    period,
    collected: {
      invoice_count: invoices.length,
      tax_cents: collectedTax,
      amount_cents: collectedAmount,
    },
    paid_overhead: {
      count: overheadExpenses.length,
      tax_cents: overheadTax,
      amount_cents: overheadAmount,
      by_category: overheadByCategory,
    },
    paid_project_work: {
      expense_count: projectExpenses.length,
      bill_count: bills.length,
      tax_cents: projectTotalTax,
      amount_cents: projectTotalAmount,
      by_project: byProjectLines,
    },
    net_owed_cents: collectedTax - overheadTax - projectTotalTax,
    filed,
    missing_bn: missingBn,
  };
}

// ============================================================================
// Period presets
// ============================================================================

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function gstPeriodPresets(today: Date = new Date()): Array<{
  key: string;
  label: string;
  period: RemittancePeriod;
}> {
  const y = today.getFullYear();
  const m = today.getMonth();
  const q = Math.floor(m / 3);

  const monthStart = new Date(Date.UTC(y, m, 1));
  const monthEnd = new Date(Date.UTC(y, m + 1, 0));

  const prevMonthStart = new Date(Date.UTC(y, m - 1, 1));
  const prevMonthEnd = new Date(Date.UTC(y, m, 0));

  const quarterStart = new Date(Date.UTC(y, q * 3, 1));
  const quarterEnd = new Date(Date.UTC(y, q * 3 + 3, 0));

  const prevQuarter = q === 0 ? { y: y - 1, q: 3 } : { y, q: q - 1 };
  const prevQuarterStart = new Date(Date.UTC(prevQuarter.y, prevQuarter.q * 3, 1));
  const prevQuarterEnd = new Date(Date.UTC(prevQuarter.y, prevQuarter.q * 3 + 3, 0));

  const yearStart = new Date(Date.UTC(y, 0, 1));
  const yearEnd = new Date(Date.UTC(y, 11, 31));

  const prevYearStart = new Date(Date.UTC(y - 1, 0, 1));
  const prevYearEnd = new Date(Date.UTC(y - 1, 11, 31));

  return [
    {
      key: 'this_month',
      label: 'This month',
      period: { from: iso(monthStart), to: iso(monthEnd) },
    },
    {
      key: 'last_month',
      label: 'Last month',
      period: { from: iso(prevMonthStart), to: iso(prevMonthEnd) },
    },
    {
      key: 'this_quarter',
      label: `Q${q + 1} ${y}`,
      period: { from: iso(quarterStart), to: iso(quarterEnd) },
    },
    {
      key: 'last_quarter',
      label: `Q${prevQuarter.q + 1} ${prevQuarter.y}`,
      period: { from: iso(prevQuarterStart), to: iso(prevQuarterEnd) },
    },
    {
      key: 'this_year',
      label: `${y} YTD`,
      period: { from: iso(yearStart), to: iso(yearEnd) },
    },
    {
      key: 'last_year',
      label: `${y - 1}`,
      period: { from: iso(prevYearStart), to: iso(prevYearEnd) },
    },
  ];
}

/**
 * Recent filings for a tenant (most recent first). Used by the side-
 * panel on the GST page so the operator can see what's been filed.
 */
export async function listRecentFilings(tenantId: string, limit = 8): Promise<FiledRemittance[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('gst_remittances')
    .select('id, paid_at, amount_cents, reference, notes, period_from, period_to')
    .eq('tenant_id', tenantId)
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Filings list: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    paid_at: r.paid_at as string,
    amount_cents: r.amount_cents as number,
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  }));
}

export async function listRecentFilingsWithPeriods(
  tenantId: string,
  limit = 8,
): Promise<Array<FiledRemittance & { period_from: string; period_to: string }>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('gst_remittances')
    .select('id, paid_at, amount_cents, reference, notes, period_from, period_to')
    .eq('tenant_id', tenantId)
    .order('paid_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Filings list: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    paid_at: r.paid_at as string,
    amount_cents: r.amount_cents as number,
    reference: (r.reference as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    period_from: r.period_from as string,
    period_to: r.period_to as string,
  }));
}
