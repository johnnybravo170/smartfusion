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
  committed_cents: number;
  actual_bills_cents: number;
  actual_expenses_cents: number;
  actual_total_cents: number;
  margin_at_risk_cents: number;
  by_category: VarianceRow[];
}> {
  // Sourced from getBudgetVsActual so Overview groups + numbers match the
  // Budget tab exactly. Previously this function grouped by the cost_lines
  // `category` enum (material/labour/sub/equipment/overhead) which lied
  // about the project's actual category structure (operator-named
  // budget_categories). Single source of truth now.
  const { getBudgetVsActual } = await import('./project-budget-categories');
  const supabase = await createClient();

  const [budget, billsRes, expensesRes] = await Promise.all([
    getBudgetVsActual(projectId),
    supabase.from('project_bills').select('amount_cents').eq('project_id', projectId),
    supabase.from('expenses').select('amount_cents').eq('project_id', projectId),
  ]);

  const bills = (billsRes.data ?? []) as { amount_cents: number }[];
  const expenseRows = (expensesRes.data ?? []) as { amount_cents: number }[];

  const actual_bills_cents = bills.reduce((s, b) => s + b.amount_cents, 0);
  const actual_expenses_cents = expenseRows.reduce((s, e) => s + e.amount_cents, 0);
  const actual_total_cents = actual_bills_cents + actual_expenses_cents;

  const estimated_cents = budget.total_estimate_cents;
  const committed_cents = budget.total_committed_cents;
  // Margin at risk = what's left in the envelope minus what's already
  // committed. Negative means we've over-committed before all work lands.
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
    committed_cents,
    actual_bills_cents,
    actual_expenses_cents,
    actual_total_cents,
    margin_at_risk_cents,
    by_category,
  };
}
