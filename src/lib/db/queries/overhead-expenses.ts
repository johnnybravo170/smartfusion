/**
 * Overhead expense queries — operating expenses not tied to any project.
 * Same `expenses` table as project expenses; filtered by `project_id IS NULL`.
 */

import { createClient } from '@/lib/supabase/server';

export type OverheadExpenseRow = {
  id: string;
  expense_date: string;
  amount_cents: number;
  tax_cents: number;
  vendor: string | null;
  description: string | null;
  receipt_storage_path: string | null;
  category_id: string | null;
  category_name: string | null;
  parent_category_name: string | null;
};

export async function listOverheadExpenses(opts?: {
  from?: string;
  to?: string;
  categoryId?: string;
}): Promise<OverheadExpenseRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from('expenses')
    .select(
      'id, expense_date, amount_cents, tax_cents, vendor, description, receipt_storage_path, category_id, categories:category_id (name, parent:parent_id (name))',
    )
    .is('project_id', null)
    .order('expense_date', { ascending: false });

  if (opts?.from) query = query.gte('expense_date', opts.from);
  if (opts?.to) query = query.lte('expense_date', opts.to);
  if (opts?.categoryId) query = query.eq('category_id', opts.categoryId);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list overhead expenses: ${error.message}`);

  return (data ?? []).map((row) => {
    const catRaw = (row as Record<string, unknown>).categories as
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }
      | { name?: string; parent?: { name?: string } | { name?: string }[] | null }[]
      | null;
    const cat = Array.isArray(catRaw) ? catRaw[0] : catRaw;
    const parentRaw = cat?.parent;
    const parent = Array.isArray(parentRaw) ? parentRaw[0] : parentRaw;
    return {
      id: row.id as string,
      expense_date: row.expense_date as string,
      amount_cents: row.amount_cents as number,
      tax_cents: (row.tax_cents as number) ?? 0,
      vendor: (row.vendor as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      receipt_storage_path: (row.receipt_storage_path as string | null) ?? null,
      category_id: (row.category_id as string | null) ?? null,
      category_name: (cat?.name as string | undefined) ?? null,
      parent_category_name: (parent?.name as string | undefined) ?? null,
    };
  });
}
