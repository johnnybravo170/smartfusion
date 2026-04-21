import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerTimeEntry = {
  id: string;
  entry_date: string;
  hours: number;
  hourly_rate_cents: number | null;
  notes: string | null;
  project_id: string | null;
  project_name: string | null;
  bucket_id: string | null;
  bucket_name: string | null;
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
      'id, entry_date, hours, hourly_rate_cents, notes, project_id, bucket_id, created_at, projects:project_id (name), project_cost_buckets:bucket_id (name)',
    )
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
    const project = r.projects as { name?: string } | { name?: string }[] | null;
    const bucket = r.project_cost_buckets as { name?: string } | { name?: string }[] | null;
    const proj = Array.isArray(project) ? project[0] : project;
    const buck = Array.isArray(bucket) ? bucket[0] : bucket;
    return {
      id: r.id as string,
      entry_date: r.entry_date as string,
      hours: Number(r.hours),
      hourly_rate_cents: (r.hourly_rate_cents as number | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      project_id: (r.project_id as string | null) ?? null,
      project_name: proj?.name ?? null,
      bucket_id: (r.bucket_id as string | null) ?? null,
      bucket_name: buck?.name ?? null,
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
      'id, entry_date, hours, hourly_rate_cents, notes, project_id, bucket_id, created_at, projects:project_id (name), project_cost_buckets:bucket_id (name)',
    )
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .eq('id', entryId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return null;

  const r = data as unknown as Record<string, unknown>;
  const project = r.projects as { name?: string } | { name?: string }[] | null;
  const bucket = r.project_cost_buckets as { name?: string } | { name?: string }[] | null;
  const proj = Array.isArray(project) ? project[0] : project;
  const buck = Array.isArray(bucket) ? bucket[0] : bucket;
  return {
    id: r.id as string,
    entry_date: r.entry_date as string,
    hours: Number(r.hours),
    hourly_rate_cents: (r.hourly_rate_cents as number | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    project_id: (r.project_id as string | null) ?? null,
    project_name: proj?.name ?? null,
    bucket_id: (r.bucket_id as string | null) ?? null,
    bucket_name: buck?.name ?? null,
    created_at: r.created_at as string,
  };
}

export type ProjectWithBuckets = {
  project_id: string;
  project_name: string;
  buckets: Array<{ id: string; name: string }>;
};

export async function listWorkerProjectsWithBuckets(
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
    .from('project_cost_buckets')
    .select('id, name, project_id')
    .in('project_id', projectIds)
    .order('display_order', { ascending: true });

  const bucketsByProject = new Map<string, Array<{ id: string; name: string }>>();
  for (const b of buckets ?? []) {
    const pid = b.project_id as string;
    const arr = bucketsByProject.get(pid) ?? [];
    arr.push({ id: b.id as string, name: b.name as string });
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
