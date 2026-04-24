/**
 * Server-side reads for the Tasks module. All queries run under RLS via
 * `createClient()` — owner/admin sees everything in their tenant, workers
 * only see their assigned rows.
 */

import { createClient } from '@/lib/supabase/server';
import type { TaskStatus } from '@/lib/validators/task';

export type TaskRow = {
  id: string;
  tenant_id: string;
  title: string;
  description: string | null;
  scope: 'personal' | 'project' | 'lead';
  job_id: string | null;
  lead_id: string | null;
  phase: string | null;
  status: TaskStatus;
  blocker_reason: string | null;
  assignee_id: string | null;
  created_by: string;
  visibility: 'internal' | 'crew' | 'client';
  client_summary: string | null;
  required_photos: boolean;
  due_date: string | null;
  completed_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLS =
  'id, tenant_id, title, description, scope, job_id, lead_id, phase, status, blocker_reason, assignee_id, created_by, visibility, client_summary, required_photos, due_date, completed_at, verified_at, created_at, updated_at';

export async function listTasksForJob(jobId: string): Promise<TaskRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('tasks')
    .select(SELECT_COLS)
    .eq('job_id', jobId)
    .order('created_at', { ascending: true });
  return (data ?? []) as TaskRow[];
}

export async function listPersonalTasks(userId: string): Promise<TaskRow[]> {
  const supabase = await createClient();
  // Show open tasks + tasks completed within the last 24h.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('tasks')
    .select(SELECT_COLS)
    .eq('scope', 'personal')
    .eq('created_by', userId)
    .or(`status.neq.done,completed_at.gte.${cutoff}`)
    .order('created_at', { ascending: false });
  return (data ?? []) as TaskRow[];
}

export type DashboardTaskBuckets = {
  dueToday: TaskRow[];
  overdue: TaskRow[];
  blockedClient: TaskRow[];
  blockedMaterial: TaskRow[];
  blockedSub: TaskRow[];
  blockedOther: TaskRow[];
  personalTop: TaskRow[];
};

/**
 * Bucket open tasks for the owner command center. One round-trip; we slice
 * the result client-side because the table is small and we save a query.
 */
export async function getDashboardTaskBuckets(userId: string): Promise<DashboardTaskBuckets> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('tasks')
    .select(SELECT_COLS)
    .not('status', 'in', '(done,verified)')
    .order('due_date', { ascending: true, nullsFirst: false });

  const rows = (data ?? []) as TaskRow[];
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const dueToday: TaskRow[] = [];
  const overdue: TaskRow[] = [];
  const blockedClient: TaskRow[] = [];
  const blockedMaterial: TaskRow[] = [];
  const blockedSub: TaskRow[] = [];
  const blockedOther: TaskRow[] = [];
  const personalTop: TaskRow[] = [];

  for (const r of rows) {
    if (r.scope === 'personal' && r.created_by === userId) {
      if (personalTop.length < 5) personalTop.push(r);
    }
    if (r.due_date) {
      if (r.due_date === todayStr) dueToday.push(r);
      else if (r.due_date < todayStr) overdue.push(r);
    }
    if (r.status === 'waiting_client') blockedClient.push(r);
    else if (r.status === 'waiting_material') blockedMaterial.push(r);
    else if (r.status === 'waiting_sub') blockedSub.push(r);
    else if (r.status === 'blocked') blockedOther.push(r);
  }

  // Overdue sorted by days overdue desc — `due_date` ascending puts oldest first.
  overdue.sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));

  return {
    dueToday,
    overdue,
    blockedClient,
    blockedMaterial,
    blockedSub,
    blockedOther,
    personalTop,
  };
}

/**
 * Per-job task health for the owner dashboard quick-view list.
 * Returns one row per job that has at least one open task, with the
 * overall health colour computed from the underlying task set.
 */
export type JobTaskHealth = {
  job_id: string;
  customer_name: string | null;
  health: 'green' | 'yellow' | 'red';
  open_count: number;
};

export async function getJobTaskHealth(): Promise<JobTaskHealth[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('tasks')
    .select('job_id, status, due_date, jobs:job_id (id, customers:customer_id (name))')
    .eq('scope', 'project')
    .not('status', 'in', '(done,verified)');

  const rows = (data ?? []) as Array<{
    job_id: string | null;
    status: TaskStatus;
    due_date: string | null;
    jobs:
      | { id: string; customers: { name: string } | { name: string }[] | null }
      | { id: string; customers: { name: string } | { name: string }[] | null }[]
      | null;
  }>;

  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const byJob = new Map<string, JobTaskHealth>();
  for (const r of rows) {
    if (!r.job_id) continue;
    const jobObj = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    const customerObj = jobObj
      ? Array.isArray(jobObj.customers)
        ? jobObj.customers[0]
        : jobObj.customers
      : null;
    const customerName = customerObj?.name ?? null;

    const existing = byJob.get(r.job_id) ?? {
      job_id: r.job_id,
      customer_name: customerName,
      health: 'green' as const,
      open_count: 0,
    };
    existing.open_count += 1;

    const isOverdue = r.due_date && r.due_date < todayStr;
    const isBlocked =
      r.status === 'blocked' ||
      r.status === 'waiting_client' ||
      r.status === 'waiting_material' ||
      r.status === 'waiting_sub';

    if (isOverdue) existing.health = 'red';
    else if (isBlocked && existing.health !== 'red') existing.health = 'yellow';

    byJob.set(r.job_id, existing);
  }

  return Array.from(byJob.values()).sort((a, b) => {
    const order = { red: 0, yellow: 1, green: 2 } as const;
    return order[a.health] - order[b.health];
  });
}
