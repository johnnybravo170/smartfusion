import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerExpense = {
  id: string;
  expense_date: string;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  receipt_storage_path: string | null;
  receipt_url: string | null;
  project_id: string | null;
  project_name: string | null;
  budget_category_id: string | null;
  budget_category_name: string | null;
  created_at: string;
};

export async function listWorkerExpenses(
  tenantId: string,
  workerProfileId: string,
  limit = 200,
): Promise<WorkerExpense[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('expenses')
    .select(
      'id, expense_date, amount_cents, vendor, description, receipt_storage_path, receipt_url, project_id, budget_category_id, created_at, projects:project_id (name), project_budget_categories:budget_category_id (name)',
    )
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .order('expense_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const project = r.projects as { name?: string } | { name?: string }[] | null;
    const category = r.project_budget_categories as { name?: string } | { name?: string }[] | null;
    const proj = Array.isArray(project) ? project[0] : project;
    const cat = Array.isArray(category) ? category[0] : category;
    return {
      id: r.id as string,
      expense_date: r.expense_date as string,
      amount_cents: Number(r.amount_cents),
      vendor: (r.vendor as string | null) ?? null,
      description: (r.description as string | null) ?? null,
      receipt_storage_path: (r.receipt_storage_path as string | null) ?? null,
      receipt_url: (r.receipt_url as string | null) ?? null,
      project_id: (r.project_id as string | null) ?? null,
      project_name: proj?.name ?? null,
      budget_category_id: (r.budget_category_id as string | null) ?? null,
      budget_category_name: cat?.name ?? null,
      created_at: r.created_at as string,
    };
  });
}

export async function canWorkerLogExpenses(args: {
  tenantDefault: boolean;
  profileOverride: boolean | null;
}): Promise<boolean> {
  return args.profileOverride ?? args.tenantDefault;
}
