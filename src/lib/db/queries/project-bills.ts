/**
 * Project bills listing. As of the cost-unification rollout this reads
 * from `project_costs` filtered to `source_type='vendor_bill'`. The
 * output shape is preserved exactly so the project Bills subtab keeps
 * showing identical numbers — bills.amount_cents is the pre-GST
 * subtotal (read from `pre_tax_amount_cents`, which the backfill copied
 * verbatim from the legacy `project_bills.amount_cents`).
 *
 * The `status` field is derived from `payment_status`: 'paid' → 'paid';
 * 'unpaid' → 'pending' (the legacy default). The 'approved' state
 * doesn't survive the unification — no live write path was setting it —
 * so unpaid bills surface as 'pending'.
 */

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
    .from('project_costs')
    .select(
      'id, tenant_id, project_id, vendor, cost_date, description, amount_cents, pre_tax_amount_cents, gst_cents, payment_status, receipt_url, external_ref, vendor_gst_number, budget_category_id, cost_line_id, attachment_storage_path, created_at, updated_at, project_budget_categories(name)',
    )
    .eq('source_type', 'vendor_bill')
    .eq('status', 'active')
    .eq('project_id', projectId)
    .order('cost_date', { ascending: false });
  if (error) throw new Error(`Failed to list project bills: ${error.message}`);
  return ((data ?? []) as unknown[]).map((row) => {
    const r = row as Record<string, unknown>;
    const categoryRel = r.project_budget_categories as { name: string } | null;
    return {
      id: r.id as string,
      tenant_id: r.tenant_id as string,
      project_id: r.project_id as string,
      vendor: (r.vendor as string | null) ?? '',
      bill_date: r.cost_date as string,
      description: (r.description as string | null) ?? null,
      // amount_cents on bills is the pre-GST subtotal (matches legacy
      // project_bills.amount_cents semantics). Fall back to gross
      // amount_cents for any legacy bill predating migration 0083.
      amount_cents: (r.pre_tax_amount_cents as number | null) ?? (r.amount_cents as number) ?? 0,
      gst_cents: (r.gst_cents as number) ?? 0,
      status: (r.payment_status === 'paid' ? 'paid' : 'pending') as BillStatus,
      receipt_url: (r.receipt_url as string | null) ?? null,
      cost_code: (r.external_ref as string | null) ?? null,
      vendor_gst_number: (r.vendor_gst_number as string | null) ?? null,
      budget_category_id: (r.budget_category_id as string | null) ?? null,
      budget_category_name: categoryRel?.name ?? null,
      cost_line_id: (r.cost_line_id as string | null) ?? null,
      attachment_storage_path: (r.attachment_storage_path as string | null) ?? null,
      created_at: r.created_at as string,
      updated_at: r.updated_at as string,
    } satisfies ProjectBillRow;
  });
}
