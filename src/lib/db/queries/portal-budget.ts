/**
 * Customer-facing budget rollup for the portal.
 *
 * Uses the admin client because the portal authenticates via portal_slug
 * (no Supabase auth context). Mirrors getBudgetVsActual's per-bucket
 * spent computation but strips committed/labor/expense breakdowns,
 * collapsing everything into a single "spent so far" number per bucket.
 *
 * Rules:
 * - Categories with `is_visible_in_report = false` are excluded from
 *   the per-bucket list (operator's existing flag for internal-only
 *   buckets — same flag used by customer-facing reports).
 * - Approved change-order cost breakdowns ARE rolled into per-bucket
 *   totals when they reference an existing bucket; uncategorized CO
 *   impact rolls into the project-level total only.
 * - Estimate per bucket prefers `lines_total_cents` (sum of priced cost
 *   lines) over `estimate_cents` envelope when lines exist — same rule
 *   as the operator Budget tab to avoid drift between the two surfaces.
 */

import { canadianTax } from '@/lib/providers/tax/canadian';
import type { createAdminClient } from '@/lib/supabase/admin';

export type PortalBudgetCategory = {
  id: string;
  name: string;
  display_order: number;
  /** Original estimate + approved CO impact attributed to this bucket. */
  total_cents: number;
  /** Actual spend (labor + expenses + bills) for this bucket. */
  spent_cents: number;
};

export type PortalBudgetSummary = {
  categories: PortalBudgetCategory[];
  /** Sum of all bucket totals + uncategorized approved CO impact. */
  project_total_cents: number;
  /** Sum of all bucket spend. */
  project_spent_cents: number;
  /** Total draws invoiced to the customer ('sent' + 'paid' invoices, doc_type='draw'). */
  draws_invoiced_cents: number;
  /** Subset of draws_invoiced that the customer has paid. */
  draws_paid_cents: number;
  /** Whether any draw has been issued. Drives whether the payments block renders. */
  has_draws: boolean;
  /**
   * What the customer is actually on the hook for: project_total_cents
   * grossed up by the project's management_fee_rate and the customer-
   * facing tax rate (GST/HST only — PST is operator-internal). Shown in
   * small print so the customer doesn't get a false sense of cost from
   * the cost-basis numbers.
   */
  customer_contract_total_cents: number;
  /** Tax label like "GST" or "HST" or "GST + HST" for the contract-total footnote. */
  tax_label: string;
};

export async function getPortalBudgetSummary(
  admin: ReturnType<typeof createAdminClient>,
  projectId: string,
): Promise<PortalBudgetSummary> {
  const [
    { data: categories },
    { data: timeData },
    { data: costData },
    { data: costLineData },
    { data: cos },
    drawsResult,
    { data: project },
  ] = await Promise.all([
    admin
      .from('project_budget_categories')
      .select('id, name, estimate_cents, display_order, is_visible_in_report')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true }),
    admin
      .from('time_entries')
      .select('budget_category_id, hours, hourly_rate_cents')
      .eq('project_id', projectId),
    // Receipts + bills come from project_costs (cost-unification rollout).
    // Variance math is preserved byte-identical: receipts use the gross
    // amount_cents, vendor bills use pre_tax_amount_cents (the backfill
    // copied it verbatim from the legacy project_bills.amount_cents
    // pre-GST subtotal). Settling on a single convention is deferred to
    // the UI-unification PR so portal numbers don't shift here.
    admin
      .from('project_costs')
      .select('budget_category_id, source_type, amount_cents, pre_tax_amount_cents')
      .eq('project_id', projectId)
      .eq('status', 'active'),
    admin
      .from('project_cost_lines')
      .select('budget_category_id, line_price_cents')
      .eq('project_id', projectId),
    admin
      .from('change_orders')
      .select('cost_impact_cents, cost_breakdown')
      .eq('project_id', projectId)
      .eq('status', 'approved'),
    admin
      .from('invoices')
      .select('amount_cents, tax_cents, tax_inclusive, status')
      .eq('project_id', projectId)
      .eq('doc_type', 'draw')
      .is('deleted_at', null)
      .in('status', ['sent', 'paid']),
    admin
      .from('projects')
      .select('tenant_id, management_fee_rate, customers:customer_id (tax_exempt)')
      .eq('id', projectId)
      .maybeSingle(),
  ]);

  const sumByCategory = (
    rows: ReadonlyArray<Record<string, unknown>> | null,
    valueFn: (r: Record<string, unknown>) => number,
  ): Map<string, number> => {
    const map = new Map<string, number>();
    for (const r of rows ?? []) {
      const cat = r.budget_category_id as string | null;
      if (!cat) continue;
      map.set(cat, (map.get(cat) ?? 0) + valueFn(r));
    }
    return map;
  };

  const labor = sumByCategory(timeData, (r) => {
    const hours = (r.hours as number) ?? 0;
    const rate = (r.hourly_rate_cents as number) ?? 0;
    return Math.round(hours * rate);
  });
  // Split project_costs into receipts (gross) and vendor bills
  // (pre-GST) so per-bucket variance numbers match the legacy
  // implementation byte-for-byte (see query comment above).
  const expense = sumByCategory(
    (costData ?? []).filter((r) => (r as { source_type?: string }).source_type !== 'vendor_bill'),
    (r) => (r.amount_cents as number) ?? 0,
  );
  const bills = sumByCategory(
    (costData ?? []).filter((r) => (r as { source_type?: string }).source_type === 'vendor_bill'),
    (r) => (r.pre_tax_amount_cents as number | null) ?? (r.amount_cents as number) ?? 0,
  );
  const lines = sumByCategory(costLineData, (r) => (r.line_price_cents as number) ?? 0);

  // Approved CO impact, both per-bucket (when cost_breakdown references a
  // bucket) and project-level (full cost_impact_cents on every CO,
  // including uncategorized portions).
  const coByCategory = new Map<string, number>();
  let coUncategorizedCents = 0;
  let coTotalCents = 0;
  for (const co of (cos ?? []) as Array<Record<string, unknown>>) {
    const total = (co.cost_impact_cents as number) ?? 0;
    coTotalCents += total;
    const breakdown =
      (co.cost_breakdown as Array<{ budget_category_id?: string; amount_cents?: number }> | null) ??
      [];
    let attributed = 0;
    for (const entry of breakdown) {
      if (!entry.budget_category_id) continue;
      const amt = entry.amount_cents ?? 0;
      coByCategory.set(
        entry.budget_category_id,
        (coByCategory.get(entry.budget_category_id) ?? 0) + amt,
      );
      attributed += amt;
    }
    coUncategorizedCents += Math.max(0, total - attributed);
  }

  type CategoryRow = {
    id: string;
    name: string;
    estimate_cents: number;
    display_order: number;
    is_visible_in_report: boolean;
  };
  const allRows = (categories ?? []) as CategoryRow[];

  const visibleCategories: PortalBudgetCategory[] = [];
  let projectTotalFromBuckets = 0;
  let projectSpent = 0;

  for (const cat of allRows) {
    const linesTotal = lines.get(cat.id) ?? 0;
    const baseEstimate = linesTotal > 0 ? linesTotal : cat.estimate_cents;
    const coImpact = coByCategory.get(cat.id) ?? 0;
    const total = baseEstimate + coImpact;
    const spent = (labor.get(cat.id) ?? 0) + (expense.get(cat.id) ?? 0) + (bills.get(cat.id) ?? 0);

    projectSpent += spent;
    if (cat.is_visible_in_report && total > 0) {
      visibleCategories.push({
        id: cat.id,
        name: cat.name,
        display_order: cat.display_order,
        total_cents: total,
        spent_cents: spent,
      });
      projectTotalFromBuckets += total;
    } else {
      // Hidden buckets still contribute their estimate + CO impact to the
      // project-level rollup so the customer's total isn't artificially low.
      projectTotalFromBuckets += total;
    }
  }

  // Draws — sent + paid sums on doc_type='draw' invoices for this project.
  let drawsInvoiced = 0;
  let drawsPaid = 0;
  for (const r of (drawsResult.data ?? []) as Array<Record<string, unknown>>) {
    const amount = (r.amount_cents as number) ?? 0;
    const tax = (r.tax_cents as number) ?? 0;
    const taxInclusive = Boolean(r.tax_inclusive);
    const total = taxInclusive ? amount : amount + tax;
    drawsInvoiced += total;
    if (r.status === 'paid') drawsPaid += total;
  }
  const hasDraws = (drawsResult.data ?? []).length > 0;

  // Customer contract total = budget × (1 + mgmt_rate) × (1 + tax_rate).
  // Cost-basis budget numbers above don't include the management fee or
  // customer-facing tax — without showing the gross-up, the homeowner
  // can develop a false sense of how much the job costs them.
  const projectTotal = projectTotalFromBuckets + coUncategorizedCents;
  const tenantId = (project?.tenant_id as string | null | undefined) ?? null;
  const mgmtRate = Number((project?.management_fee_rate as number | null | undefined) ?? 0) || 0;
  const customerRaw = project?.customers as
    | { tax_exempt?: boolean | null }
    | { tax_exempt?: boolean | null }[]
    | null
    | undefined;
  const customer = Array.isArray(customerRaw) ? (customerRaw[0] ?? null) : (customerRaw ?? null);
  const taxExempt = Boolean(customer?.tax_exempt);

  let taxRate = 0;
  let taxLabel = '';
  if (tenantId && !taxExempt) {
    try {
      const ctx = await canadianTax.getCustomerFacingContext(tenantId);
      taxRate = ctx.totalRate;
      taxLabel = ctx.summaryLabel;
    } catch (_e) {
      // Tax lookup failure shouldn't break the portal — fall back to no
      // gross-up. The customer just sees the cost-basis number.
    }
  }

  const beforeTax = Math.round(projectTotal * (1 + mgmtRate));
  const customerContractTotal = Math.round(beforeTax * (1 + taxRate));

  return {
    categories: visibleCategories,
    project_total_cents: projectTotal,
    project_spent_cents: projectSpent,
    draws_invoiced_cents: drawsInvoiced,
    draws_paid_cents: drawsPaid,
    has_draws: hasDraws,
    customer_contract_total_cents: customerContractTotal,
    tax_label: taxLabel || 'tax',
  };
}

/**
 * Visibility resolver. Project-level override wins; falls back to tenant
 * default; falls back to false. Both columns are nullable; null on the
 * project means "inherit tenant."
 */
export function shouldShowPortalBudget(
  projectShow: boolean | null | undefined,
  tenantShow: boolean | null | undefined,
): boolean {
  if (projectShow === true) return true;
  if (projectShow === false) return false;
  return Boolean(tenantShow);
}
