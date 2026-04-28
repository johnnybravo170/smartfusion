/**
 * Change order queries through the RLS-aware Supabase server client.
 */

import { createClient } from '@/lib/supabase/server';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';

export type ChangeOrderRow = {
  id: string;
  project_id: string | null;
  job_id: string | null;
  tenant_id: string;
  title: string;
  description: string;
  reason: string | null;
  cost_impact_cents: number;
  timeline_impact_days: number;
  affected_buckets: string[];
  cost_breakdown: { budget_category_id: string; amount_cents: number }[];
  status: ChangeOrderStatus;
  approval_code: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  approval_method: string | null;
  approved_by_member_id: string | null;
  approval_proof_paths: string[];
  approval_notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const CO_COLUMNS =
  'id, project_id, job_id, tenant_id, title, description, reason, cost_impact_cents, timeline_impact_days, affected_buckets, cost_breakdown, status, approval_code, approved_by_name, approved_at, declined_at, declined_reason, approval_method, approved_by_member_id, approval_proof_paths, approval_notes, created_by, created_at, updated_at';

/**
 * Tenant-wide pending-approval change orders for the owner dashboard.
 * Joins through the job to surface the customer name in the listing.
 */
export async function listPendingChangeOrdersForDashboard(): Promise<
  Array<{ id: string; job_id: string | null; total_cents: number; customer_name: string | null }>
> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('change_orders')
    .select('id, job_id, cost_impact_cents, status, jobs:job_id (id, customers:customer_id (name))')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: false })
    .limit(20);

  return (data ?? []).map((row) => {
    const jobObj = Array.isArray(row.jobs) ? row.jobs[0] : row.jobs;
    const customerObj = jobObj
      ? Array.isArray(jobObj.customers)
        ? jobObj.customers[0]
        : jobObj.customers
      : null;
    return {
      id: row.id as string,
      job_id: (row.job_id as string | null) ?? null,
      total_cents: (row.cost_impact_cents as number) ?? 0,
      customer_name: (customerObj?.name as string | undefined) ?? null,
    };
  });
}

export async function listChangeOrders(
  scope: { projectId: string } | { jobId: string },
): Promise<ChangeOrderRow[]> {
  const supabase = await createClient();
  let query = supabase
    .from('change_orders')
    .select(CO_COLUMNS)
    .order('created_at', { ascending: false });

  if ('projectId' in scope) {
    query = query.eq('project_id', scope.projectId);
  } else {
    query = query.eq('job_id', scope.jobId);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(`Failed to list change orders: ${error.message}`);
  }
  return (data ?? []) as ChangeOrderRow[];
}

export async function getChangeOrder(id: string): Promise<ChangeOrderRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select(CO_COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load change order: ${error.message}`);
  }
  return (data as ChangeOrderRow) ?? null;
}

export async function getChangeOrderSummaryForProject(projectId: string): Promise<{
  approved_cost_cents: number;
  pending_cost_cents: number;
  approved_timeline_days: number;
  pending_timeline_days: number;
  pending_count: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select('status, cost_impact_cents, timeline_impact_days')
    .eq('project_id', projectId)
    .in('status', ['approved', 'pending_approval']);

  if (error) {
    throw new Error(`Failed to get change order summary: ${error.message}`);
  }

  let approved_cost_cents = 0;
  let pending_cost_cents = 0;
  let approved_timeline_days = 0;
  let pending_timeline_days = 0;
  let pending_count = 0;

  for (const row of data ?? []) {
    const r = row as { status: string; cost_impact_cents: number; timeline_impact_days: number };
    if (r.status === 'approved') {
      approved_cost_cents += r.cost_impact_cents;
      approved_timeline_days += r.timeline_impact_days;
    } else {
      pending_cost_cents += r.cost_impact_cents;
      pending_timeline_days += r.timeline_impact_days;
      pending_count += 1;
    }
  }

  return {
    approved_cost_cents,
    pending_cost_cents,
    approved_timeline_days,
    pending_timeline_days,
    pending_count,
  };
}

export async function getChangeOrderSummaryForJob(jobId: string): Promise<{
  approved_cost_cents: number;
  pending_cost_cents: number;
  approved_timeline_days: number;
  pending_timeline_days: number;
  pending_count: number;
}> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select('status, cost_impact_cents, timeline_impact_days')
    .eq('job_id', jobId)
    .in('status', ['approved', 'pending_approval']);

  if (error) {
    throw new Error(`Failed to get change order summary for job: ${error.message}`);
  }

  let approved_cost_cents = 0;
  let pending_cost_cents = 0;
  let approved_timeline_days = 0;
  let pending_timeline_days = 0;
  let pending_count = 0;

  for (const row of data ?? []) {
    const r = row as { status: string; cost_impact_cents: number; timeline_impact_days: number };
    if (r.status === 'approved') {
      approved_cost_cents += r.cost_impact_cents;
      approved_timeline_days += r.timeline_impact_days;
    } else {
      pending_cost_cents += r.cost_impact_cents;
      pending_timeline_days += r.timeline_impact_days;
      pending_count += 1;
    }
  }

  return {
    approved_cost_cents,
    pending_cost_cents,
    approved_timeline_days,
    pending_timeline_days,
    pending_count,
  };
}
