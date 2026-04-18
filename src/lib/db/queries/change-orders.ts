/**
 * Change order queries through the RLS-aware Supabase server client.
 */

import { createClient } from '@/lib/supabase/server';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';

export type ChangeOrderRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  title: string;
  description: string;
  reason: string | null;
  cost_impact_cents: number;
  timeline_impact_days: number;
  affected_buckets: string[];
  status: ChangeOrderStatus;
  approval_code: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const CO_COLUMNS =
  'id, project_id, tenant_id, title, description, reason, cost_impact_cents, timeline_impact_days, affected_buckets, status, approval_code, approved_by_name, approved_at, declined_at, declined_reason, created_by, created_at, updated_at';

export async function listChangeOrders(projectId: string): Promise<ChangeOrderRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('change_orders')
    .select(CO_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

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
