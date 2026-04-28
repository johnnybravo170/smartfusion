/**
 * Cost bucket queries for renovation projects.
 *
 * `getBudgetVsActual` returns each bucket's estimate alongside its actual
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
  section: string;
  estimate_cents: number;
  labor_cents: number;
  expense_cents: number;
  bills_cents: number;
  actual_cents: number;
  remaining_cents: number;
  is_visible_in_report: boolean;
};

export type BudgetSummary = {
  lines: BudgetLine[];
  total_estimate_cents: number;
  total_actual_cents: number;
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
      throw new Error(`Failed to list buckets: ${error.message}`);
    }
    return (data ?? []) as BudgetCategoryRow[];
  },
);

export async function getBudgetVsActual(projectId: string): Promise<BudgetSummary> {
  const supabase = await createClient();

  // 1. Load all buckets for this project
  const buckets = await listBudgetCategoriesForProject(projectId);

  // 2. Load time entries for this project, grouped by budget_category_id
  const { data: timeData, error: timeErr } = await supabase
    .from('time_entries')
    .select('budget_category_id, hours, hourly_rate_cents')
    .eq('project_id', projectId);

  if (timeErr) {
    throw new Error(`Failed to load time entries: ${timeErr.message}`);
  }

  // 3. Load expenses for this project, grouped by budget_category_id
  const { data: expenseData, error: expErr } = await supabase
    .from('expenses')
    .select('budget_category_id, amount_cents')
    .eq('project_id', projectId);

  if (expErr) {
    throw new Error(`Failed to load expenses: ${expErr.message}`);
  }

  // 4. Load bills for this project, grouped by budget_category_id (pre-GST subtotal only)
  const { data: billData, error: billErr } = await supabase
    .from('project_bills')
    .select('budget_category_id, amount_cents')
    .eq('project_id', projectId);

  if (billErr) {
    throw new Error(`Failed to load bills: ${billErr.message}`);
  }

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

  // Build budget lines
  const lines: BudgetLine[] = buckets.map((b) => {
    const labor_cents = laborByBudgetCategory.get(b.id) ?? 0;
    const expense_cents = expenseByBudgetCategory.get(b.id) ?? 0;
    const bills_cents = billsByBudgetCategory.get(b.id) ?? 0;
    const actual_cents = labor_cents + expense_cents + bills_cents;
    return {
      budget_category_id: b.id,
      budget_category_name: b.name,
      section: b.section,
      estimate_cents: b.estimate_cents,
      labor_cents,
      expense_cents,
      bills_cents,
      actual_cents,
      remaining_cents: b.estimate_cents - actual_cents,
      is_visible_in_report: b.is_visible_in_report,
    };
  });

  const total_estimate_cents = lines.reduce((sum, l) => sum + l.estimate_cents, 0);
  const total_actual_cents = lines.reduce((sum, l) => sum + l.actual_cents, 0);

  return {
    lines,
    total_estimate_cents,
    total_actual_cents,
    total_remaining_cents: total_estimate_cents - total_actual_cents,
  };
}
