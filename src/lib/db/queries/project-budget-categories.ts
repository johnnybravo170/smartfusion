/**
 * Budget category queries for renovation projects.
 *
 * `getBudgetVsActual` returns each category's estimate alongside its actual
 * spend (labor from time_entries + expenses). Used by the project detail
 * page and the AI budget tool.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';

export type BudgetCategoryRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  name: string;
  section: string;
  description: string | null;
  estimate_cents: number;
  display_order: number;
  is_visible_in_report: boolean;
  created_at: string;
  updated_at: string;
};

export type BudgetLine = {
  budget_category_id: string;
  budget_category_name: string;
  budget_category_description: string | null;
  section: string;
  estimate_cents: number;
  labor_cents: number;
  expense_cents: number;
  bills_cents: number;
  actual_cents: number;
  /**
   * Committed = money promised but not yet realized: PO line items in
   * sent/acknowledged/received status, + accepted vendor quote
   * allocations. Spent counts WITH committed when computing remaining,
   * since committed money is already reserved.
   *
   * Known caveat: when a PO becomes a Bill, both may briefly show
   * concurrently (PO not yet closed, bill filed). Real
   * double-count-avoidance needs `bills.po_id` + `pos.sub_quote_id` FKs;
   * tracked separately. For now treat committed as a leading indicator.
   */
  committed_cents: number;
  spent_committed_cents: number;
  remaining_cents: number;
  /**
   * Sum of `project_cost_lines.line_price_cents` under this category.
   * Surfaced separately from `estimate_cents` so the UI can show drift
   * between the customer-facing envelope (estimate_cents) and the
   * operator's internal line breakdown without auto-rolling one into
   * the other (envelope = contractual; lines = internal plan, may
   * differ for margin or rounding).
   */
  lines_total_cents: number;
  is_visible_in_report: boolean;
};

export type BudgetSummary = {
  lines: BudgetLine[];
  total_estimate_cents: number;
  total_actual_cents: number;
  total_committed_cents: number;
  total_remaining_cents: number;
};

export const listBudgetCategoriesForProject = cache(
  async (projectId: string): Promise<BudgetCategoryRow[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from('project_budget_categories')
      .select('*')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true })
      .order('name', { ascending: true });

    if (error) {
      throw new Error(`Failed to list categories: ${error.message}`);
    }
    return (data ?? []) as BudgetCategoryRow[];
  },
);

export async function getBudgetVsActual(projectId: string): Promise<BudgetSummary> {
  const supabase = await createClient();

  // 1. Load all categories for this project
  const categories = await listBudgetCategoriesForProject(projectId);

  // 2. Load time entries for this project, grouped by budget_category_id
  const { data: timeData, error: timeErr } = await supabase
    .from('time_entries')
    .select('budget_category_id, hours, hourly_rate_cents')
    .eq('project_id', projectId);

  if (timeErr) {
    throw new Error(`Failed to load time entries: ${timeErr.message}`);
  }

  // 3+4. Load receipts + vendor bills from the unified project_costs
  // table, grouped by budget_category_id. Receipts contribute gross
  // amount_cents; vendor bills contribute the pre-GST subtotal (GST is
  // an ITC, not a project cost). The split below preserves the
  // pre-unification mixed semantics so variance numbers don't shift.
  const { data: costData, error: costErr } = await supabase
    .from('project_costs')
    .select('budget_category_id, source_type, amount_cents, pre_tax_amount_cents')
    .eq('project_id', projectId)
    .eq('status', 'active');

  if (costErr) {
    throw new Error(`Failed to load project costs: ${costErr.message}`);
  }

  const expenseData = (costData ?? [])
    .filter((r) => (r as { source_type?: string }).source_type !== 'vendor_bill')
    .map((r) => ({
      budget_category_id: (r as { budget_category_id: string | null }).budget_category_id,
      amount_cents: (r as { amount_cents: number }).amount_cents ?? 0,
    }));
  const billData = (costData ?? [])
    .filter((r) => (r as { source_type?: string }).source_type === 'vendor_bill')
    .map((r) => ({
      budget_category_id: (r as { budget_category_id: string | null }).budget_category_id,
      amount_cents:
        (r as { pre_tax_amount_cents: number | null }).pre_tax_amount_cents ??
        (r as { amount_cents: number }).amount_cents ??
        0,
    }));

  // 4a. Load cost lines summed per category. Used as a fallback when a
  // category's stored envelope is 0 but priced lines exist under it
  // (e.g. AI-scaffolded projects always insert categories with
  // estimate_cents=0; if the operator prices the lines and never sets
  // an envelope, the Budget tab would otherwise display $0 totals
  // while the Estimate tab + project Overview correctly show the lines
  // sum via scope_subtotal_cents in cost-lines.ts).
  const { data: costLineData, error: costLineErr } = await supabase
    .from('project_cost_lines')
    .select('budget_category_id, line_price_cents')
    .eq('project_id', projectId);

  if (costLineErr) {
    throw new Error(`Failed to load cost lines: ${costLineErr.message}`);
  }

  // 5. Committed: accepted vendor quote allocations + active PO line items.
  // Vendor quotes have direct budget_category_id on allocations. POs have
  // it indirectly via PO line items → cost_lines.budget_category_id.
  const { data: subQuoteAllocs } = await supabase
    .from('project_sub_quote_allocations')
    .select('allocated_cents, budget_category_id, project_sub_quotes!inner(project_id, status)')
    .eq('project_sub_quotes.project_id', projectId)
    .eq('project_sub_quotes.status', 'accepted');

  const { data: poItems } = await supabase
    .from('purchase_order_items')
    .select(
      'line_total_cents, project_cost_lines(budget_category_id), purchase_orders!inner(project_id, status)',
    )
    .eq('purchase_orders.project_id', projectId)
    .in('purchase_orders.status', ['sent', 'acknowledged', 'received']);

  // Aggregate labor by budget_category_id
  const laborByBudgetCategory = new Map<string, number>();
  for (const entry of timeData ?? []) {
    const e = entry as {
      budget_category_id: string | null;
      hours: number;
      hourly_rate_cents: number | null;
    };
    if (!e.budget_category_id) continue;
    const cost = Math.round((e.hours ?? 0) * (e.hourly_rate_cents ?? 0));
    laborByBudgetCategory.set(
      e.budget_category_id,
      (laborByBudgetCategory.get(e.budget_category_id) ?? 0) + cost,
    );
  }

  // Aggregate expenses by budget_category_id
  const expenseByBudgetCategory = new Map<string, number>();
  for (const entry of expenseData ?? []) {
    const e = entry as { budget_category_id: string | null; amount_cents: number };
    if (!e.budget_category_id) continue;
    expenseByBudgetCategory.set(
      e.budget_category_id,
      (expenseByBudgetCategory.get(e.budget_category_id) ?? 0) + e.amount_cents,
    );
  }

  // Aggregate bills by budget_category_id (pre-GST subtotal — GST is an ITC, not a project cost)
  const billsByBudgetCategory = new Map<string, number>();
  for (const entry of billData ?? []) {
    const e = entry as { budget_category_id: string | null; amount_cents: number };
    if (!e.budget_category_id) continue;
    billsByBudgetCategory.set(
      e.budget_category_id,
      (billsByBudgetCategory.get(e.budget_category_id) ?? 0) + e.amount_cents,
    );
  }

  // Aggregate cost lines by budget_category_id (envelope fallback source)
  const linesByBudgetCategory = new Map<string, number>();
  for (const entry of costLineData ?? []) {
    const e = entry as { budget_category_id: string | null; line_price_cents: number | null };
    if (!e.budget_category_id) continue;
    linesByBudgetCategory.set(
      e.budget_category_id,
      (linesByBudgetCategory.get(e.budget_category_id) ?? 0) + (e.line_price_cents ?? 0),
    );
  }

  // Aggregate accepted-quote allocations by budget_category_id
  const committedByBudgetCategory = new Map<string, number>();
  for (const entry of subQuoteAllocs ?? []) {
    const e = entry as { allocated_cents: number; budget_category_id: string | null };
    if (!e.budget_category_id) continue;
    committedByBudgetCategory.set(
      e.budget_category_id,
      (committedByBudgetCategory.get(e.budget_category_id) ?? 0) + (e.allocated_cents ?? 0),
    );
  }
  // Aggregate active PO line items by budget_category_id (via cost_line).
  // PostgREST returns the joined relation as an array even on a 1:1 FK,
  // so we read [0]. Skips PO items without a linked cost_line (free-text
  // ad-hoc PO items aren't attributable to a budget category today).
  for (const entry of poItems ?? []) {
    const e = entry as unknown as {
      line_total_cents: number;
      project_cost_lines:
        | { budget_category_id: string | null }
        | { budget_category_id: string | null }[]
        | null;
    };
    const linked = Array.isArray(e.project_cost_lines)
      ? e.project_cost_lines[0]
      : e.project_cost_lines;
    const cat = linked?.budget_category_id;
    if (!cat) continue;
    committedByBudgetCategory.set(
      cat,
      (committedByBudgetCategory.get(cat) ?? 0) + (e.line_total_cents ?? 0),
    );
  }

  // Build budget lines
  const lines: BudgetLine[] = categories.map((b) => {
    const labor_cents = laborByBudgetCategory.get(b.id) ?? 0;
    const expense_cents = expenseByBudgetCategory.get(b.id) ?? 0;
    const bills_cents = billsByBudgetCategory.get(b.id) ?? 0;
    const actual_cents = labor_cents + expense_cents + bills_cents;
    const committed_cents = committedByBudgetCategory.get(b.id) ?? 0;
    const spent_committed_cents = actual_cents + committed_cents;
    // Single source of truth: when a bucket has any priced cost lines,
    // the lines sum IS the estimate. Envelope is only consulted for
    // envelope-only buckets (no priced lines yet). This matches the
    // project-level rollup in cost-lines.ts and removes the drift case
    // where envelope and lines could disagree on the same screen.
    const lines_total_cents = linesByBudgetCategory.get(b.id) ?? 0;
    const estimate_cents = lines_total_cents > 0 ? lines_total_cents : b.estimate_cents;
    return {
      budget_category_id: b.id,
      budget_category_name: b.name,
      budget_category_description: b.description,
      section: b.section,
      estimate_cents,
      labor_cents,
      expense_cents,
      bills_cents,
      actual_cents,
      committed_cents,
      spent_committed_cents,
      // Remaining now subtracts both spent AND committed — committed money
      // is effectively reserved against the envelope.
      remaining_cents: estimate_cents - spent_committed_cents,
      lines_total_cents,
      is_visible_in_report: b.is_visible_in_report,
    };
  });

  const total_estimate_cents = lines.reduce((sum, l) => sum + l.estimate_cents, 0);
  const total_actual_cents = lines.reduce((sum, l) => sum + l.actual_cents, 0);
  const total_committed_cents = lines.reduce((sum, l) => sum + l.committed_cents, 0);

  return {
    lines,
    total_estimate_cents,
    total_actual_cents,
    total_committed_cents,
    total_remaining_cents: total_estimate_cents - total_actual_cents - total_committed_cents,
  };
}
