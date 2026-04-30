import { createClient } from '@/lib/supabase/server';

export type BillStatus = 'pending' | 'approved' | 'paid';

export type ProjectBillRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  vendor: string;
  bill_date: string;
  description: string | null;
  amount_cents: number;
  gst_cents: number;
  status: BillStatus;
  receipt_url: string | null;
  cost_code: string | null;
  vendor_gst_number: string | null;
  budget_category_id: string | null;
  budget_category_name: string | null;
  cost_line_id: string | null;
  attachment_storage_path: string | null;
  created_at: string;
  updated_at: string;
};

export async function listProjectBills(projectId: string): Promise<ProjectBillRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_bills')
    .select(
      'id, tenant_id, project_id, vendor, bill_date, description, amount_cents, gst_cents, status, receipt_url, cost_code, vendor_gst_number, budget_category_id, cost_line_id, attachment_storage_path, created_at, updated_at, project_budget_categories(name)',
    )
    .eq('project_id', projectId)
    .order('bill_date', { ascending: false });
  if (error) throw new Error(`Failed to list project bills: ${error.message}`);
  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    const bucketRel = r.project_budget_categories as { name: string } | null;
    return {
      id: r.id as string,
      tenant_id: r.tenant_id as string,
      project_id: r.project_id as string,
      vendor: r.vendor as string,
      bill_date: r.bill_date as string,
      description: (r.description as string | null) ?? null,
      amount_cents: (r.amount_cents as number) ?? 0,
      gst_cents: (r.gst_cents as number) ?? 0,
      status: r.status as BillStatus,
      receipt_url: (r.receipt_url as string | null) ?? null,
      cost_code: (r.cost_code as string | null) ?? null,
      vendor_gst_number: (r.vendor_gst_number as string | null) ?? null,
      budget_category_id: (r.budget_category_id as string | null) ?? null,
      budget_category_name: bucketRel?.name ?? null,
      cost_line_id: (r.cost_line_id as string | null) ?? null,
      attachment_storage_path: (r.attachment_storage_path as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    } satisfies ProjectBillRow;
  });
}
