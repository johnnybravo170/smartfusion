import { createClient } from '@/lib/supabase/server';

export type CostLineRow = {
  id: string;
  project_id: string;
  bucket_id: string | null;
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
  'id, project_id, bucket_id, catalog_item_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, markup_pct, line_cost_cents, line_price_cents, sort_order, notes, created_at, updated_at';

export async function listCostLines(projectId: string): Promise<CostLineRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_cost_lines')
    .select(COLS)
    .eq('project_id', projectId)
    .order('sort_order')
    .order('created_at');
  if (error) throw new Error(`Failed to list cost lines: ${error.message}`);
  return (data ?? []) as CostLineRow[];
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
  const supabase = await createClient();

  // Fetch all in parallel.
  const [linesRes, posRes, billsRes, expensesRes] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select('category, line_cost_cents, line_price_cents')
      .eq('project_id', projectId),
    supabase
      .from('purchase_orders')
      .select('total_cents, status')
      .eq('project_id', projectId)
      .in('status', ['sent', 'acknowledged', 'received']),
    supabase
      .from('project_bills')
      .select('amount_cents')
      .eq('project_id', projectId),
    supabase
      .from('expenses')
      .select('amount_cents')
      .eq('project_id', projectId),
  ]);

  const lines = (linesRes.data ?? []) as { category: string; line_cost_cents: number; line_price_cents: number }[];
  const pos = (posRes.data ?? []) as { total_cents: number }[];
  const bills = (billsRes.data ?? []) as { amount_cents: number }[];
  const expenseRows = (expensesRes.data ?? []) as { amount_cents: number }[];

  const estimated_cents = lines.reduce((s, l) => s + l.line_price_cents, 0);
  const committed_cents = pos.reduce((s, p) => s + p.total_cents, 0);
  const actual_bills_cents = bills.reduce((s, b) => s + b.amount_cents, 0);
  const actual_expenses_cents = expenseRows.reduce((s, e) => s + e.amount_cents, 0);
  const actual_total_cents = actual_bills_cents + actual_expenses_cents;
  const margin_at_risk_cents = estimated_cents - actual_total_cents;

  // Rollup by category.
  const categoryMap = new Map<string, { estimated: number; cost: number }>();
  for (const l of lines) {
    const existing = categoryMap.get(l.category) ?? { estimated: 0, cost: 0 };
    categoryMap.set(l.category, {
      estimated: existing.estimated + l.line_price_cents,
      cost: existing.cost + l.line_cost_cents,
    });
  }

  const by_category: VarianceRow[] = Array.from(categoryMap.entries()).map(([cat, vals]) => ({
    category: cat,
    estimated_cents: vals.estimated,
    committed_cents: 0,
    actual_cents: 0,
    margin_at_risk_cents: vals.estimated,
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
