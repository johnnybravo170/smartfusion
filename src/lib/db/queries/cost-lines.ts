import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type CostLineRow = {
  id: string;
  project_id: string;
  budget_category_id: string | null;
  catalog_item_id: string | null;
  category: 'material' | 'labour' | 'sub' | 'equipment' | 'overhead';
  label: string;
  qty: number;
  unit: string;
  unit_cost_cents: number;
  unit_price_cents: number;
  markup_pct: number;
  line_cost_cents: number;
  line_price_cents: number;
  sort_order: number;
  notes: string | null;
  photo_storage_paths: string[];
  created_at: string;
  updated_at: string;
};

export type VarianceRow = {
  category: string;
  estimated_cents: number;
  committed_cents: number;
  actual_cents: number;
  margin_at_risk_cents: number;
};

const COLS =
  'id, project_id, budget_category_id, catalog_item_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, markup_pct, line_cost_cents, line_price_cents, sort_order, notes, photo_storage_paths, created_at, updated_at';

export const listCostLines = cache(async (projectId: string): Promise<CostLineRow[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_cost_lines')
    .select(COLS)
    .eq('project_id', projectId)
    .order('sort_order')
    .order('created_at');
  if (error) throw new Error(`Failed to list cost lines: ${error.message}`);
  return (data ?? []) as CostLineRow[];
});

/**
 * Derived progress numbers for a project. Two distinct concepts:
 *
 * - `workStatusPct` — "where are we in the job?" 0-100. For lifecycle 'complete'
 *   this is always 100. For active projects it's cost-to-cost capped at 99
 *   (because final paint/punchlist doesn't add cost — work isn't done until
 *   lifecycle flips). Used everywhere user-facing: project list, portal, etc.
 *
 * - `costBurnPct` — pure financial signal: cost incurred / estimated revenue,
 *   uncapped. Can exceed 100 (over budget). Surfaced on the variance tab so
 *   the gap between this and workStatusPct is the over/under-budget signal.
 */
export type ProjectProgress = {
  workStatusPct: number;
  costBurnPct: number;
  estRevenueCents: number;
  actualCostCents: number;
};

function computeProgress(
  lifecycleStage: string,
  estRevenueCents: number,
  actualCostCents: number,
): ProjectProgress {
  const burn = estRevenueCents > 0 ? (actualCostCents / estRevenueCents) * 100 : 0;
  let workStatusPct: number;
  if (lifecycleStage === 'complete') {
    workStatusPct = 100;
  } else if (lifecycleStage === 'cancelled') {
    workStatusPct = 0;
  } else {
    workStatusPct = Math.min(99, Math.round(burn));
  }
  return {
    workStatusPct,
    costBurnPct: Math.round(burn),
    estRevenueCents,
    actualCostCents,
  };
}

/** Batch-fetch progress for many projects in one round-trip. */
export async function listProjectProgress(
  projectIds: string[],
): Promise<Map<string, ProjectProgress>> {
  const out = new Map<string, ProjectProgress>();
  if (projectIds.length === 0) return out;

  const supabase = await createClient();
  const [linesRes, billsRes, expensesRes, projectsRes] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select('project_id, line_price_cents')
      .in('project_id', projectIds),
    supabase.from('project_bills').select('project_id, amount_cents').in('project_id', projectIds),
    supabase.from('expenses').select('project_id, amount_cents').in('project_id', projectIds),
    supabase.from('projects').select('id, lifecycle_stage').in('id', projectIds),
  ]);

  const est = new Map<string, number>();
  for (const r of (linesRes.data ?? []) as { project_id: string; line_price_cents: number }[]) {
    est.set(r.project_id, (est.get(r.project_id) ?? 0) + r.line_price_cents);
  }
  const cost = new Map<string, number>();
  for (const r of (billsRes.data ?? []) as { project_id: string; amount_cents: number }[]) {
    cost.set(r.project_id, (cost.get(r.project_id) ?? 0) + r.amount_cents);
  }
  for (const r of (expensesRes.data ?? []) as { project_id: string; amount_cents: number }[]) {
    cost.set(r.project_id, (cost.get(r.project_id) ?? 0) + r.amount_cents);
  }
  const stage = new Map<string, string>();
  for (const r of (projectsRes.data ?? []) as { id: string; lifecycle_stage: string }[]) {
    stage.set(r.id, r.lifecycle_stage);
  }

  for (const id of projectIds) {
    out.set(id, computeProgress(stage.get(id) ?? 'planning', est.get(id) ?? 0, cost.get(id) ?? 0));
  }
  return out;
}

export async function getProjectProgress(projectId: string): Promise<ProjectProgress> {
  const map = await listProjectProgress([projectId]);
  return (
    map.get(projectId) ?? {
      workStatusPct: 0,
      costBurnPct: 0,
      estRevenueCents: 0,
      actualCostCents: 0,
    }
  );
}

export async function getVarianceReport(projectId: string): Promise<{
  estimated_cents: number;
  /** Sum of cost_lines (the customer-visible line subtotal — pre mgmt fee). */
  lines_subtotal_cents: number;
  /** Management fee applied on top of the line subtotal. Includes any
   *  per-CO override deltas (see mgmt_fee_breakdown). */
  mgmt_fee_cents: number;
  /** Project-level default management fee rate (0..0.5). */
  mgmt_fee_rate: number;
  /** Per-CO override breakdown — surfaced on the Overview revenue card so
   *  operators can see the effective rate evolve as scaled-back COs land.
   *  Empty when no applied CO has an override set. */
  mgmt_fee_breakdown: {
    /** Lines + applied COs at the project default rate. */
    baseline_lines_cents: number;
    baseline_fee_cents: number;
    /** One row per applied CO with an override rate set. */
    co_overrides: {
      co_id: string;
      cost_impact_cents: number;
      override_rate: number;
      fee_cents: number;
    }[];
    /** Effective blended rate = total_fee / lines_subtotal. */
    effective_rate: number;
  };
  /** Sum of operator-set per-category budget envelopes. May diverge from
   *  lines_subtotal when envelopes hold "squishy" budget headroom or when
   *  cost_lines exceed envelope. */
  envelope_total_cents: number;
  /** Cumulative cost impact of applied (v2) COs, already baked into
   *  lines_subtotal. Surfaced separately so Overview can show how much
   *  of revenue came from change orders vs the original scope. */
  applied_co_impact_cents: number;
  /** Pending COs awaiting customer approval — not yet baked into
   *  lines_subtotal. Surfaced as "if approved" projection. */
  pending_co_impact_cents: number;
  pending_co_count: number;
  committed_cents: number;
  /** Committed split: accepted vendor quote allocations + active PO line items. */
  committed_vendor_quotes_cents: number;
  committed_pos_cents: number;
  actual_bills_cents: number;
  actual_expenses_cents: number;
  actual_labour_cents: number;
  actual_total_cents: number;
  margin_at_risk_cents: number;
  by_category: VarianceRow[];
}> {
  // Two semantically distinct totals to keep the Overview honest:
  //
  // - Customer contract revenue: sum(cost_lines.line_price_cents) + mgmt
  //   fee. This matches what the homeowner signed and what the Estimate
  //   tab grand total shows. Surfaced as "Estimated Revenue."
  // - Operator envelope total: sum(budget_categories.estimate_cents).
  //   Shown in the per-category breakdown — where the operator allocates
  //   the contract dollars across buckets, with optional headroom.
  //
  // These can diverge legitimately (mgmt fee, squishy envelope, lines
  // outside their envelope). Showing both side-by-side is the audit lens.
  const { getBudgetVsActual } = await import('./project-budget-categories');
  const supabase = await createClient();

  const [
    budget,
    billsRes,
    expensesRes,
    linesRes,
    projectRes,
    timeRes,
    cosRes,
    subQuotesRes,
    poItemsRes,
  ] = await Promise.all([
    getBudgetVsActual(projectId),
    supabase.from('project_bills').select('amount_cents').eq('project_id', projectId),
    supabase.from('expenses').select('amount_cents').eq('project_id', projectId),
    supabase.from('project_cost_lines').select('line_price_cents').eq('project_id', projectId),
    supabase.from('projects').select('management_fee_rate').eq('id', projectId).maybeSingle(),
    supabase.from('time_entries').select('hours, hourly_rate_cents').eq('project_id', projectId),
    supabase
      .from('change_orders')
      .select(
        'id, status, applied_at, cost_impact_cents, flow_version, management_fee_override_rate',
      )
      .eq('project_id', projectId),
    supabase
      .from('project_sub_quote_allocations')
      .select('allocated_cents, project_sub_quotes!inner(project_id, status)')
      .eq('project_sub_quotes.project_id', projectId)
      .eq('project_sub_quotes.status', 'accepted'),
    supabase
      .from('purchase_order_items')
      .select('line_total_cents, purchase_orders!inner(project_id, status)')
      .eq('purchase_orders.project_id', projectId)
      .in('purchase_orders.status', ['sent', 'acknowledged', 'received']),
  ]);

  const bills = (billsRes.data ?? []) as { amount_cents: number }[];
  const expenseRows = (expensesRes.data ?? []) as { amount_cents: number }[];
  const lineRows = (linesRes.data ?? []) as { line_price_cents: number }[];
  const timeRows = (timeRes.data ?? []) as { hours: number; hourly_rate_cents: number | null }[];
  const coRows = (cosRes.data ?? []) as {
    id: string;
    status: string;
    applied_at: string | null;
    cost_impact_cents: number;
    flow_version: number;
    management_fee_override_rate: number | null;
  }[];
  const subQuoteAllocs = (subQuotesRes.data ?? []) as { allocated_cents: number }[];
  const poItems = (poItemsRes.data ?? []) as { line_total_cents: number }[];

  const actual_bills_cents = bills.reduce((s, b) => s + b.amount_cents, 0);
  const actual_expenses_cents = expenseRows.reduce((s, e) => s + e.amount_cents, 0);
  const actual_labour_cents = timeRows.reduce(
    (s, e) => s + Math.round((e.hours ?? 0) * (e.hourly_rate_cents ?? 0)),
    0,
  );
  const actual_total_cents = actual_bills_cents + actual_expenses_cents + actual_labour_cents;

  const lines_subtotal_cents = lineRows.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmt_fee_rate = (projectRes.data?.management_fee_rate as number | null) ?? 0;
  const envelope_total_cents = budget.total_estimate_cents;

  // Per-CO management fee overrides. Applied (v2) COs already added their
  // cost_impact into lines_subtotal_cents, so the project rate would
  // otherwise apply uniformly. To honor an override, peel out that CO's
  // share of the subtotal and re-apply at its override rate.
  //
  // Math:
  //   overridden_co_impact = Σ cost_impact for applied COs with an override
  //   overridden_co_fee    = Σ (cost_impact × override_rate)
  //   baseline_lines       = lines_subtotal − overridden_co_impact
  //   mgmt_fee_cents       = baseline_lines × project_rate + overridden_co_fee
  //
  // Negative cost_impact (descope CO) naturally reduces the fee. v1 COs
  // are not in lines_subtotal, so their override is ignored here (same
  // as how their cost_impact is invisible to estimated_cents today).
  const overrideRows = coRows.filter(
    (c) =>
      c.flow_version === 2 &&
      c.applied_at !== null &&
      c.management_fee_override_rate !== null &&
      typeof c.management_fee_override_rate === 'number',
  );
  const co_overrides = overrideRows.map((c) => {
    const rate = c.management_fee_override_rate as number;
    return {
      co_id: c.id,
      cost_impact_cents: c.cost_impact_cents,
      override_rate: rate,
      fee_cents: Math.round(c.cost_impact_cents * rate),
    };
  });
  const overridden_co_impact_cents = co_overrides.reduce((s, c) => s + c.cost_impact_cents, 0);
  const overridden_co_fee_cents = co_overrides.reduce((s, c) => s + c.fee_cents, 0);
  const baseline_lines_cents = lines_subtotal_cents - overridden_co_impact_cents;
  const baseline_fee_cents = Math.round(baseline_lines_cents * mgmt_fee_rate);
  const mgmt_fee_cents = baseline_fee_cents + overridden_co_fee_cents;
  const effective_rate =
    lines_subtotal_cents > 0 ? mgmt_fee_cents / lines_subtotal_cents : mgmt_fee_rate;

  // Customer-contract revenue. Matches the Estimate tab grand total.
  const estimated_cents = lines_subtotal_cents + mgmt_fee_cents;

  const applied_co_impact_cents = coRows
    .filter((c) => c.flow_version === 2 && c.applied_at !== null)
    .reduce((s, c) => s + c.cost_impact_cents, 0);
  const pendingCos = coRows.filter((c) => c.status === 'pending_approval');
  const pending_co_impact_cents = pendingCos.reduce((s, c) => s + c.cost_impact_cents, 0);
  const pending_co_count = pendingCos.length;

  const committed_vendor_quotes_cents = subQuoteAllocs.reduce(
    (s, a) => s + (a.allocated_cents ?? 0),
    0,
  );
  const committed_pos_cents = poItems.reduce((s, p) => s + (p.line_total_cents ?? 0), 0);
  const committed_cents = budget.total_committed_cents;
  const margin_at_risk_cents = estimated_cents - actual_total_cents - committed_cents;

  const by_category: VarianceRow[] = budget.lines.map((l) => ({
    category: l.budget_category_name,
    estimated_cents: l.estimate_cents,
    committed_cents: l.committed_cents,
    actual_cents: l.actual_cents,
    margin_at_risk_cents: l.remaining_cents,
  }));

  return {
    estimated_cents,
    lines_subtotal_cents,
    mgmt_fee_cents,
    mgmt_fee_rate,
    mgmt_fee_breakdown: {
      baseline_lines_cents,
      baseline_fee_cents,
      co_overrides,
      effective_rate,
    },
    envelope_total_cents,
    applied_co_impact_cents,
    pending_co_impact_cents,
    pending_co_count,
    committed_cents,
    committed_vendor_quotes_cents,
    committed_pos_cents,
    actual_bills_cents,
    actual_expenses_cents,
    actual_labour_cents,
    actual_total_cents,
    margin_at_risk_cents,
    by_category,
  };
}
