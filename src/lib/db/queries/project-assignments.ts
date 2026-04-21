import { createAdminClient } from '@/lib/supabase/admin';

export type ProjectAssignmentRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  worker_profile_id: string;
  scheduled_date: string | null;
  hourly_rate_cents: number | null;
  notes: string | null;
  created_at: string;
};

const COLUMNS =
  'id, tenant_id, project_id, worker_profile_id, scheduled_date, hourly_rate_cents, notes, created_at';

export async function listAssignmentsForProject(
  tenantId: string,
  projectId: string,
): Promise<ProjectAssignmentRow[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('project_assignments')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('project_id', projectId)
    .order('scheduled_date', { ascending: true, nullsFirst: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as ProjectAssignmentRow[];
}

export type WorkerAssignedProject = {
  project_id: string;
  project_name: string;
  customer_name: string | null;
  status: string;
  target_end_date: string | null;
  next_scheduled_date: string | null;
};

/** Projects this worker is assigned to (ongoing or day-scheduled), active first. */
export async function listProjectsForWorker(
  tenantId: string,
  workerProfileId: string,
): Promise<WorkerAssignedProject[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('project_assignments')
    .select('project_id, scheduled_date')
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId);
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  if (rows.length === 0) return [];

  const today = new Date().toISOString().slice(0, 10);
  const projectIds = Array.from(new Set(rows.map((r) => r.project_id as string)));

  // Earliest upcoming scheduled_date per project (>= today), or null.
  const nextByProject = new Map<string, string | null>();
  for (const pid of projectIds) nextByProject.set(pid, null);
  for (const r of rows) {
    const d = r.scheduled_date as string | null;
    if (!d || d < today) continue;
    const current = nextByProject.get(r.project_id as string);
    if (!current || d < current) nextByProject.set(r.project_id as string, d);
  }

  const { data: projects, error: projErr } = await admin
    .from('projects')
    .select('id, name, status, target_end_date, customers:customer_id (name)')
    .in('id', projectIds)
    .is('deleted_at', null);
  if (projErr) throw new Error(projErr.message);

  const statusRank: Record<string, number> = {
    in_progress: 0,
    planning: 1,
    complete: 2,
    cancelled: 3,
  };

  return ((projects ?? []) as unknown as Array<Record<string, unknown>>)
    .map((p) => {
      const customersRaw = p.customers as { name?: string } | { name?: string }[] | null;
      const customer = Array.isArray(customersRaw) ? customersRaw[0] : customersRaw;
      return {
        project_id: p.id as string,
        project_name: p.name as string,
        customer_name: (customer?.name as string | undefined) ?? null,
        status: p.status as string,
        target_end_date: (p.target_end_date as string | null) ?? null,
        next_scheduled_date: nextByProject.get(p.id as string) ?? null,
      };
    })
    .sort(
      (a, b) =>
        (statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99) ||
        a.project_name.localeCompare(b.project_name),
    );
}

export async function getAssignment(
  tenantId: string,
  assignmentId: string,
): Promise<ProjectAssignmentRow | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('project_assignments')
    .select(COLUMNS)
    .eq('id', assignmentId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  return (data as ProjectAssignmentRow) ?? null;
}

export async function isWorkerAssignedToProject(
  tenantId: string,
  workerProfileId: string,
  projectId: string,
): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('project_assignments')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('worker_profile_id', workerProfileId)
    .eq('project_id', projectId)
    .limit(1);
  return (data ?? []).length > 0;
}
