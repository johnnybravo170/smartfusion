import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerTimeEntry = {
  id: string;
  entry_date: string;
  hours: number;
  hourly_rate_cents: number | null;
  notes: string | null;
  project_id: string | null;
  project_name: string | null;
  budget_category_id: string | null;
  budget_category_name: string | null;
  cost_line_id: string | null;
  cost_line_label: string | null;
  created_at: string;
};

export async function listWorkerTimeEntries(
  tenantId: string,
  workerProfileId: string,
  limit = 200,
): Promise<WorkerTimeEntry[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_entries')
    .select(
      'id, entry_date, hours, hourly_rate_cents, notes, project_id, budget_category_id, cost_line_id, created_at, projects:project_id (name), project_budget_categories:budget_category_id (name), project_cost_lines:cost_line_id (label)',
    )
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const project = r.projects as { name?: string } | { name?: string }[] | null;
    const bucket = r.project_budget_categories as { name?: string } | { name?: string }[] | null;
    const line = r.project_cost_lines as { label?: string } | { label?: string }[] | null;
    const proj = Array.isArray(project) ? project[0] : project;
    const buck = Array.isArray(bucket) ? bucket[0] : bucket;
    const ln = Array.isArray(line) ? line[0] : line;
    return {
      id: r.id as string,
      entry_date: r.entry_date as string,
      hours: Number(r.hours),
      hourly_rate_cents: (r.hourly_rate_cents as number | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      project_id: (r.project_id as string | null) ?? null,
      project_name: proj?.name ?? null,
      budget_category_id: (r.budget_category_id as string | null) ?? null,
      budget_category_name: buck?.name ?? null,
      cost_line_id: (r.cost_line_id as string | null) ?? null,
      cost_line_label: ln?.label ?? null,
      created_at: r.created_at as string,
    };
  });
}

export async function getWorkerTimeEntry(
  tenantId: string,
  workerProfileId: string,
  entryId: string,
): Promise<WorkerTimeEntry | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_entries')
    .select(
      'id, entry_date, hours, hourly_rate_cents, notes, project_id, budget_category_id, cost_line_id, created_at, projects:project_id (name), project_budget_categories:budget_category_id (name), project_cost_lines:cost_line_id (label)',
    )
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .eq('id', entryId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const r = data as unknown as Record<string, unknown>;
  const project = r.projects as { name?: string } | { name?: string }[] | null;
  const bucket = r.project_budget_categories as { name?: string } | { name?: string }[] | null;
  const line = r.project_cost_lines as { label?: string } | { label?: string }[] | null;
  const proj = Array.isArray(project) ? project[0] : project;
  const buck = Array.isArray(bucket) ? bucket[0] : bucket;
  const ln = Array.isArray(line) ? line[0] : line;
  return {
    id: r.id as string,
    entry_date: r.entry_date as string,
    hours: Number(r.hours),
    hourly_rate_cents: (r.hourly_rate_cents as number | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    project_id: (r.project_id as string | null) ?? null,
    project_name: proj?.name ?? null,
    budget_category_id: (r.budget_category_id as string | null) ?? null,
    budget_category_name: buck?.name ?? null,
    cost_line_id: (r.cost_line_id as string | null) ?? null,
    cost_line_label: ln?.label ?? null,
    created_at: r.created_at as string,
  };
}

export type ProjectWithBuckets = {
  project_id: string;
  project_name: string;
  buckets: Array<{
    id: string;
    name: string;
    cost_lines: Array<{ id: string; label: string }>;
  }>;
};

export async function listWorkerProjectsWithBudgetCategories(
  tenantId: string,
  workerProfileId: string,
): Promise<ProjectWithBuckets[]> {
  const admin = createAdminClient();
  const { data: assignRows } = await admin
    .from('project_assignments')
    .select('project_id')
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId);

  const projectIds = Array.from(new Set((assignRows ?? []).map((r) => r.project_id as string)));
  if (projectIds.length === 0) return [];

  const { data: projects } = await admin
    .from('projects')
    .select('id, name')
    .in('id', projectIds)
    .is('deleted_at', null);

  const { data: buckets } = await admin
    .from('project_budget_categories')
    .select('id, name, project_id')
    .in('project_id', projectIds)
    .order('display_order', { ascending: true });

  const { data: costLineRows } = await admin
    .from('project_cost_lines')
    .select('id, label, budget_category_id')
    .in('project_id', projectIds)
    .order('sort_order', { ascending: true });

  const linesByBucket = new Map<string, Array<{ id: string; label: string }>>();
  for (const l of costLineRows ?? []) {
    const bid = l.budget_category_id as string | null;
    if (!bid) continue;
    const arr = linesByBucket.get(bid) ?? [];
    arr.push({ id: l.id as string, label: l.label as string });
    linesByBucket.set(bid, arr);
  }

  type Bucket = { id: string; name: string; cost_lines: Array<{ id: string; label: string }> };
  const bucketsByProject = new Map<string, Bucket[]>();
  for (const b of buckets ?? []) {
    const pid = b.project_id as string;
    const bid = b.id as string;
    const arr = bucketsByProject.get(pid) ?? [];
    arr.push({ id: bid, name: b.name as string, cost_lines: linesByBucket.get(bid) ?? [] });
    bucketsByProject.set(pid, arr);
  }

  return (projects ?? [])
    .map((p) => ({
      project_id: p.id as string,
      project_name: p.name as string,
      buckets: bucketsByProject.get(p.id as string) ?? [],
    }))
    .sort((a, b) => a.project_name.localeCompare(b.project_name));
}
