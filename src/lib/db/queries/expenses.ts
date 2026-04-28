/**
 * Expense queries for project/job expense tracking.
 */

import { createClient } from '@/lib/supabase/server';

export type ExpenseRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  worker_profile_id: string | null;
  project_id: string | null;
  budget_category_id: string | null;
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

export async function listExpenses(filters: ExpenseFilters = {}): Promise<ExpenseRow[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;

  let query = supabase.from('expenses').select('*');

  if (filters.project_id) query = query.eq('project_id', filters.project_id);
  if (filters.job_id) query = query.eq('job_id', filters.job_id);
  if (filters.user_id) query = query.eq('user_id', filters.user_id);
  if (filters.budget_category_id)
    query = query.eq('budget_category_id', filters.budget_category_id);
  if (filters.date_from) query = query.gte('expense_date', filters.date_from);
  if (filters.date_to) query = query.lte('expense_date', filters.date_to);

  const { data, error } = await query
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to list expenses: ${error.message}`);
  }
  return (data ?? []) as ExpenseRow[];
}

export async function getExpense(id: string): Promise<ExpenseRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('expenses').select('*').eq('id', id).maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load expense: ${error.message}`);
  }
  return data as ExpenseRow | null;
}
