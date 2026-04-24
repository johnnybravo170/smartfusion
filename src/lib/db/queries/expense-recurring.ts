import { createClient } from '@/lib/supabase/server';

export type RecurringRuleRow = {
  id: string;
  vendor: string | null;
  description: string | null;
  amount_cents: number;
  tax_cents: number;
  day_of_month: number;
  next_run_at: string;
  category_name: string | null;
  parent_category_name: string | null;
};

export async function listActiveRecurringRules(): Promise<RecurringRuleRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('expense_recurring_rules')
    .select(
      'id, vendor, description, amount_cents, tax_cents, day_of_month, next_run_at, categories:category_id (name, parent:parent_id (name))',
    )
    .eq('active', true)
    .order('next_run_at', { ascending: true });
  if (error) throw new Error(`Failed to list recurring rules: ${error.message}`);

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
      vendor: (row.vendor as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      amount_cents: row.amount_cents as number,
      tax_cents: (row.tax_cents as number) ?? 0,
      day_of_month: row.day_of_month as number,
      next_run_at: row.next_run_at as string,
      category_name: (cat?.name as string | undefined) ?? null,
      parent_category_name: (parent?.name as string | undefined) ?? null,
    };
  });
}
