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
  const [linesRes, costsRes, projectsRes] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select('project_id, line_price_cents')
      .in('project_id', projectIds),
    // Unified cost reads. Receipts use gross amount_cents; bills use
    // pre_tax_amount_cents to preserve the legacy mixed semantics for
    // the project-progress burn rollup.
    supabase
      .from('project_costs')
      .select('project_id, source_type, amount_cents, pre_tax_amount_cents')
      .in('project_id', projectIds)
      .eq('status', 'active'),
    supabase.from('projects').select('id, lifecycle_stage').in('id', projectIds),
  ]);

  const est = new Map<string, number>();
  for (const r of (linesRes.data ?? []) as { project_id: string; line_price_cents: number }[]) {
    est.set(r.project_id, (est.get(r.project_id) ?? 0) + r.line_price_cents);
  }
  const cost = new Map<string, number>();
  for (const r of (costsRes.data ?? []) as {
    project_id: string;
    source_type: 'receipt' | 'vendor_bill';
    amount_cents: number;
    pre_tax_amount_cents: number | null;
  }[]) {
    const amount =
      r.source_type === 'vendor_bill' ? (r.pre_tax_amount_cents ?? r.amount_cents) : r.amount_cents;
    cost.set(r.project_id, (cost.get(r.project_id) ?? 0) + amount);
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
  /** Pre-fee customer scope: per category, sum-of-lines if any line items
   *  exist, otherwise the category envelope. Captures both fully-itemized
   *  estimates AND envelope-only categories (where the operator agreed a
   *  budget without itemizing). Replaces the old "lines-only" subtotal in
   *  the revenue calc — that under-counted whenever a category was priced
   *  at the envelope level. */
  scope_subtotal_cents: number;
  /** Pure sum of cost_lines.line_price_cents — preserved for diagnostics
   *  and per-category rendering. May diverge from scope_subtotal when a
   *  category has an envelope but no lines. */
  lines_subtotal_cents: number;
  /** Management fee applied on top of the scope subtotal. Includes any
   *  per-CO override deltas (see mgmt_fee_breakdown). */
  mgmt_fee_cents: number;
  /** Project-level default management fee rate (0..0.5). */
  mgmt_fee_rate: number;
  /** Per-CO override breakdown — surfaced on the Overview revenue card so
   *  operators can see the effective rate evolve as scaled-back COs land.
   *  Empty when no applied CO has an override set. */
  mgmt_fee_breakdown: {
    /** Scope baseline + applied COs at the project default rate. */
    baseline_lines_cents: number;
    baseline_fee_cents: number;
    /** One row per applied CO with an override rate set. */
    co_overrides: {
      co_id: string;
      cost_impact_cents: number;
      override_rate: number;
      fee_cents: number;
    }[];
    /** Effective blended rate = total_fee / scope_subtotal. */
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
  //   the contract dollars across categories, with optional headroom.
  //
  // These can diverge legitimately (mgmt fee, squishy envelope, lines
  // outside their envelope). Showing both side-by-side is the audit lens.
  const { getBudgetVsActual } = await import('./project-budget-categories');
  const supabase = await createClient();

  // The RPC consolidates 8 project-level aggregations into a single
  // round-trip (see supabase/migrations/0163_project_variance_rpc.sql).
  // getBudgetVsActual still runs separately because the per-category
  // breakdown is shared with the Budget tab + AI tools — keeping it
  // separate avoids a wider refactor.
  const [budget, aggResp] = await Promise.all([
    getBudgetVsActual(projectId),
    supabase.rpc('get_project_variance_aggregates', { p_project_id: projectId }),
  ]);

  const agg = (aggResp.data ?? {}) as {
    management_fee_rate?: number | null;
    lines_subtotal_cents?: number | string | null;
    lines_by_category?: Record<string, number | string> | null;
    bills_total_cents?: number | string | null;
    expenses_total_cents?: number | string | null;
    labour_total_cents?: number | string | null;
    committed_vendor_quotes_cents?: number | string | null;
    committed_pos_cents?: number | string | null;
    change_orders?: Array<{
      id: string;
      status: string;
      applied_at: string | null;
      cost_impact_cents: number;
      flow_version: number;
      management_fee_override_rate: number | null;
    }> | null;
  };

  // Postgres bigint serialises to a string over PostgREST when it could
  // exceed JS safe-integer range; coerce defensively.
  const toNum = (v: number | string | null | undefined): number =>
    typeof v === 'string' ? Number(v) : (v ?? 0);

  const lines_subtotal_cents = toNum(agg.lines_subtotal_cents);
  const actual_bills_cents = toNum(agg.bills_total_cents);
  const actual_expenses_cents = toNum(agg.expenses_total_cents);
  const actual_labour_cents = toNum(agg.labour_total_cents);
  const committed_vendor_quotes_cents = toNum(agg.committed_vendor_quotes_cents);
  const committed_pos_cents = toNum(agg.committed_pos_cents);
  const coRows = (agg.change_orders ?? []) as {
    id: string;
    status: string;
    applied_at: string | null;
    cost_impact_cents: number;
    flow_version: number;
    management_fee_override_rate: number | null;
  }[];

  const actual_total_cents = actual_bills_cents + actual_expenses_cents + actual_labour_cents;

  const mgmt_fee_rate = (agg.management_fee_rate as number | null) ?? 0;
  const envelope_total_cents = budget.total_estimate_cents;

  // Customer scope = per category, lines if itemized, else the envelope.
  // Lets operators price at the envelope level (no line items) or itemize
  // — in either case revenue reflects what was contracted. Also captures
  // CO `modify_envelope` rows that bump a category's budget without
  // adding a line, which would otherwise be invisible to revenue.
  const linesByCategoryRaw = (agg.lines_by_category ?? {}) as Record<string, number | string>;
  const linesByCategory = new Map<string | null, number>();
  for (const [k, v] of Object.entries(linesByCategoryRaw)) {
    const key = k === '__uncategorized__' ? null : k;
    linesByCategory.set(key, toNum(v));
  }
  let scope_subtotal_cents = linesByCategory.get(null) ?? 0;
  for (const cat of budget.lines) {
    const catLines = linesByCategory.get(cat.budget_category_id) ?? 0;
    scope_subtotal_cents += catLines > 0 ? catLines : cat.estimate_cents;
  }

  // Per-CO management fee overrides. Applied (v2) COs already added their
  // cost_impact into scope_subtotal_cents, so the project rate would
  // otherwise apply uniformly. To honor an override, peel out that CO's
  // share of the subtotal and re-apply at its override rate.
  //
  // Math:
  //   overridden_co_impact = Σ cost_impact for applied COs with an override
  //   overridden_co_fee    = Σ (cost_impact × override_rate)
  //   baseline_scope       = scope_subtotal − overridden_co_impact
  //   mgmt_fee_cents       = baseline_scope × project_rate + overridden_co_fee
  //
  // Negative cost_impact (descope CO) naturally reduces the fee. v1 COs
  // are not in scope_subtotal, so their override is ignored here (same
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
  const baseline_lines_cents = scope_subtotal_cents - overridden_co_impact_cents;
  const baseline_fee_cents = Math.round(baseline_lines_cents * mgmt_fee_rate);
  const mgmt_fee_cents = baseline_fee_cents + overridden_co_fee_cents;
  const effective_rate =
    scope_subtotal_cents > 0 ? mgmt_fee_cents / scope_subtotal_cents : mgmt_fee_rate;

  // Customer-contract revenue. Matches the Estimate tab grand total.
  const estimated_cents = scope_subtotal_cents + mgmt_fee_cents;

  const applied_co_impact_cents = coRows
    .filter((c) => c.flow_version === 2 && c.applied_at !== null)
    .reduce((s, c) => s + c.cost_impact_cents, 0);
  const pendingCos = coRows.filter((c) => c.status === 'pending_approval');
  const pending_co_impact_cents = pendingCos.reduce((s, c) => s + c.cost_impact_cents, 0);
  const pending_co_count = pendingCos.length;

  // committed_vendor_quotes_cents + committed_pos_cents come from the RPC.
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
    scope_subtotal_cents,
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
