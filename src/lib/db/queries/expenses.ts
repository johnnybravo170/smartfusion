/**
 * Expense queries for project/job expense tracking.
 *
 * As of the cost-unification rollout these read from the unified
 * `project_costs` table filtered by `source_type='receipt'`. Output
 * shape (`ExpenseRow`) is preserved so callers don't need to change —
 * cost_date / attachment_storage_path map back to expense_date /
 * receipt_storage_path on the way out.
 */

import { createClient } from '@/lib/supabase/server';

export type ExpenseRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  worker_profile_id: string | null;
  project_id: string | null;
  budget_category_id: string | null;
  cost_line_id: string | null;
  job_id: string | null;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  receipt_url: string | null;
  receipt_storage_path: string | null;
  expense_date: string;
  created_at: string;
  updated_at: string;
};

export type ExpenseFilters = {
  project_id?: string;
  job_id?: string;
  user_id?: string;
  budget_category_id?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
};

type ProjectCostRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  worker_profile_id: string | null;
  project_id: string | null;
  budget_category_id: string | null;
  cost_line_id: string | null;
  job_id: string | null;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  receipt_url: string | null;
  attachment_storage_path: string | null;
  cost_date: string;
  created_at: string;
  updated_at: string;
};

function toExpenseRow(c: ProjectCostRow): ExpenseRow {
  return {
    id: c.id,
    tenant_id: c.tenant_id,
    // Receipts always have a user_id (NOT NULL on the legacy table). The
    // unified table relaxed the constraint for vendor bills, but we
    // filter to receipts only here.
    user_id: (c.user_id ?? '') as string,
    worker_profile_id: c.worker_profile_id,
    project_id: c.project_id,
    budget_category_id: c.budget_category_id,
    cost_line_id: c.cost_line_id,
    job_id: c.job_id,
    amount_cents: c.amount_cents,
    vendor: c.vendor,
    description: c.description,
    receipt_url: c.receipt_url,
    receipt_storage_path: c.attachment_storage_path,
    expense_date: c.cost_date,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

const SELECT =
  'id, tenant_id, user_id, worker_profile_id, project_id, budget_category_id, cost_line_id, job_id, amount_cents, vendor, description, receipt_url, attachment_storage_path, cost_date, created_at, updated_at';

export async function listExpenses(filters: ExpenseFilters = {}): Promise<ExpenseRow[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;

  let query = supabase
    .from('project_costs')
    .select(SELECT)
    .eq('source_type', 'receipt')
    .eq('status', 'active');

  if (filters.project_id) query = query.eq('project_id', filters.project_id);
  if (filters.job_id) query = query.eq('job_id', filters.job_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.budget_category_id)
    query = query.eq('budget_category_id', filters.budget_category_id);
  if (filters.date_from) query = query.gte('cost_date', filters.date_from);
  if (filters.date_to) query = query.lte('cost_date', filters.date_to);

  const { data, error } = await query
    .order('cost_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list expenses: ${error.message}`);
  }
  return ((data ?? []) as unknown as ProjectCostRow[]).map(toExpenseRow);
}

export async function getExpense(id: string): Promise<ExpenseRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_costs')
    .select(SELECT)
    .eq('id', id)
    .eq('source_type', 'receipt')
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load expense: ${error.message}`);
  }
  return data ? toExpenseRow(data as unknown as ProjectCostRow) : null;
}
