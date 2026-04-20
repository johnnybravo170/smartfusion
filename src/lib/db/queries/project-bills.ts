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
  status: BillStatus;
  receipt_url: string | null;
  cost_code: string | null;
  created_at: string;
  updated_at: string;
};

const COLS =
  'id, tenant_id, project_id, vendor, bill_date, description, amount_cents, status, receipt_url, cost_code, created_at, updated_at';

export async function listProjectBills(projectId: string): Promise<ProjectBillRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_bills')
    .select(COLS)
    .eq('project_id', projectId)
    .order('bill_date', { ascending: false });
  if (error) throw new Error(`Failed to list project bills: ${error.message}`);
  return (data ?? []) as ProjectBillRow[];
}
