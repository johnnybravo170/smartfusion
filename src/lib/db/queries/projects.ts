/**
 * Project queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by `current_tenant_id()` in the `projects` RLS
 * policies. We never filter on `tenant_id` in application code.
 *
 * Soft-delete: `projects.deleted_at` filters out deleted rows in all listers.
 */

import { createClient } from '@/lib/supabase/server';
import type { ProjectStatus } from '@/lib/validators/project';

export type ProjectCustomerSummary = {
  id: string;
  name: string;
  type: 'residential' | 'commercial' | 'agent';
};

export type ProjectRow = {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  phase: string | null;
  management_fee_rate: number;
  start_date: string | null;
  target_end_date: string | null;
  percent_complete: number;
  estimate_status: 'draft' | 'pending_approval' | 'approved' | 'declined';
  estimate_approval_code: string | null;
  estimate_sent_at: string | null;
  estimate_approved_at: string | null;
  estimate_approved_by_name: string | null;
  estimate_declined_at: string | null;
  estimate_declined_reason: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type ProjectWithCustomer = ProjectRow & {
  customer: ProjectCustomerSummary | null;
};

export type CostBucketSummary = {
  id: string;
  name: string;
  section: string;
  description: string | null;
  estimate_cents: number;
  display_order: number;
  is_visible_in_report: boolean;
};

export type ProjectWithRelations = ProjectWithCustomer & {
  cost_buckets: CostBucketSummary[];
};

export type ProjectListFilters = {
  status?: ProjectStatus;
  customer_id?: string;
  limit?: number;
};

export type ProjectStatusCounts = {
  planning: number;
  in_progress: number;
  complete: number;
  cancelled: number;
};

const PROJECT_COLUMNS =
  'id, tenant_id, customer_id, name, description, status, phase, management_fee_rate, start_date, target_end_date, percent_complete, estimate_status, estimate_approval_code, estimate_sent_at, estimate_approved_at, estimate_approved_by_name, estimate_declined_at, estimate_declined_reason, deleted_at, created_at, updated_at';

const PROJECT_WITH_CUSTOMER_SELECT = `${PROJECT_COLUMNS}, customers:customer_id (id, name, type)`;

function extractCustomer(raw: unknown): ProjectCustomerSummary | null {
  if (!raw) return null;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string' || typeof obj.type !== 'string') {
    return null;
  }
  return { id: obj.id, name: obj.name, type: obj.type as ProjectCustomerSummary['type'] };
}

function normalizeProject(row: Record<string, unknown>): ProjectWithCustomer {
  const { customers: customerRaw, ...rest } = row;
  return { ...(rest as ProjectRow), customer: extractCustomer(customerRaw) };
}

export async function listProjects(
  filters: ProjectListFilters = {},
): Promise<ProjectWithCustomer[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;

  let query = supabase.from('projects').select(PROJECT_WITH_CUSTOMER_SELECT).is('deleted_at', null);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);

  const { data, error } = await query.order('created_at', { ascending: false }).limit(limit);

  if (error) {
    throw new Error(`Failed to list projects: ${error.message}`);
  }
  return (data ?? []).map((row) => normalizeProject(row as Record<string, unknown>));
}

export async function getProject(id: string): Promise<ProjectWithRelations | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('projects')
    .select(
      `${PROJECT_COLUMNS},
       customers:customer_id (id, name, type)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load project: ${error.message}`);
  }
  if (!data) return null;

  const { customers: customerRaw, ...rest } = data as Record<string, unknown>;
  const base: ProjectRow = rest as ProjectRow;

  // Load cost buckets
  const { data: bucketData, error: bucketErr } = await supabase
    .from('project_cost_buckets')
    .select('id, name, section, description, estimate_cents, display_order, is_visible_in_report')
    .eq('project_id', id)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });

  if (bucketErr) {
    throw new Error(`Failed to load cost buckets: ${bucketErr.message}`);
  }

  return {
    ...base,
    customer: extractCustomer(customerRaw),
    cost_buckets: (bucketData ?? []) as CostBucketSummary[],
  };
}

export async function countProjectsByStatus(): Promise<ProjectStatusCounts> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('projects').select('status').is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to count projects: ${error.message}`);
  }

  const counts: ProjectStatusCounts = { planning: 0, in_progress: 0, complete: 0, cancelled: 0 };
  for (const row of data ?? []) {
    const s = (row as { status?: string }).status;
    if (s === 'planning' || s === 'in_progress' || s === 'complete' || s === 'cancelled') {
      counts[s] += 1;
    }
  }
  return counts;
}
