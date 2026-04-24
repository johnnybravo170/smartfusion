'use server';

/**
 * Server actions for the Tasks module.
 *
 * Mirrors `jobs.ts` style: RLS-aware client, `{ ok, error, fieldErrors }`
 * discriminant return shape, no thrown errors for expected failures.
 *
 * Worker-vs-owner field whitelisting lives in `updateTaskAction` /
 * `changeStatusAction`: workers can only land status changes through
 * `changeStatusAction`, and owners get the full update surface via
 * `updateTaskAction`.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  taskAssignSchema,
  taskCreateSchema,
  taskStatusChangeSchema,
  taskUpdateSchema,
} from '@/lib/validators/task';

/**
 * Statuses a worker is allowed to land through `workerChangeTaskStatusAction`.
 * Owners use the broader `changeStatusAction` / `verifyTaskAction` surface.
 */
const WORKER_ALLOWED_STATUSES = new Set(['in_progress', 'done', 'blocked']);

/**
 * Best-effort notification write. Uses the admin client so we can drop a
 * row against a different recipient than the caller; RLS on notifications
 * would otherwise block owner→worker and worker→owner writes.
 */
async function writeNotification(input: {
  tenantId: string;
  recipientUserId: string | null;
  kind:
    | 'task_assigned'
    | 'task_done'
    | 'task_blocked'
    | 'task_help'
    | 'task_verified'
    | 'task_rejected';
  taskId: string;
  jobId?: string | null;
  title: string;
  body?: string | null;
}) {
  try {
    const admin = createAdminClient();
    await admin.from('notifications').insert({
      tenant_id: input.tenantId,
      recipient_user_id: input.recipientUserId,
      kind: input.kind,
      task_id: input.taskId,
      job_id: input.jobId ?? null,
      title: input.title,
      body: input.body ?? null,
    });
  } catch {
    // Intentionally swallow — the data path is best-effort until real
    // push delivery is wired. TODO(phase-4): replace with Twilio / Expo.
  }
}

/**
 * Find the owner + admin user ids for a tenant. Used to ping the owner
 * when a worker marks done / blocked / need-help.
 */
async function getOwnerAdminUserIds(tenantId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenant_members')
    .select('user_id, role')
    .eq('tenant_id', tenantId)
    .in('role', ['owner', 'admin']);
  return (data ?? []).map((r) => r.user_id as string);
}

export type TaskActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

function emptyToNull(v: string | null | undefined): string | null {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed === '' ? null : trimmed;
}

function revalidateForJob(jobId: string | null | undefined) {
  if (jobId) {
    revalidatePath(`/jobs/${jobId}/tasks`);
    revalidatePath(`/jobs/${jobId}`);
  }
}

export async function createTaskAction(input: Record<string, unknown>): Promise<TaskActionResult> {
  const parsed = taskCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tasks')
    .insert({
      tenant_id: tenant.id,
      title: parsed.data.title,
      description: emptyToNull(parsed.data.description),
      scope: parsed.data.scope,
      job_id: emptyToNull(parsed.data.job_id),
      lead_id: emptyToNull(parsed.data.lead_id),
      phase: emptyToNull(parsed.data.phase),
      status: parsed.data.status,
      blocker_reason: emptyToNull(parsed.data.blocker_reason),
      assignee_id: emptyToNull(parsed.data.assignee_id),
      created_by: user.id,
      visibility: parsed.data.visibility,
      client_summary: emptyToNull(parsed.data.client_summary),
      required_photos: parsed.data.required_photos,
      due_date: emptyToNull(parsed.data.due_date),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create task.' };
  }

  revalidatePath('/dashboard');
  revalidatePath('/todos');
  revalidateForJob(emptyToNull(parsed.data.job_id));
  return { ok: true, id: data.id };
}

/**
 * Owner update — accepts a partial patch. Only fields present on the input
 * object are written. Workers should not call this; they go through
 * `changeStatusAction`.
 */
export async function updateTaskAction(input: Record<string, unknown>): Promise<TaskActionResult> {
  const parsed = taskUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if ('title' in parsed.data && parsed.data.title !== undefined) patch.title = parsed.data.title;
  if ('description' in parsed.data)
    patch.description = emptyToNull(parsed.data.description ?? null);
  if ('phase' in parsed.data) patch.phase = emptyToNull(parsed.data.phase ?? null);
  if ('status' in parsed.data && parsed.data.status) patch.status = parsed.data.status;
  if ('blocker_reason' in parsed.data)
    patch.blocker_reason = emptyToNull(parsed.data.blocker_reason ?? null);
  if ('assignee_id' in parsed.data)
    patch.assignee_id = emptyToNull(parsed.data.assignee_id ?? null);
  if ('visibility' in parsed.data && parsed.data.visibility)
    patch.visibility = parsed.data.visibility;
  if ('client_summary' in parsed.data)
    patch.client_summary = emptyToNull(parsed.data.client_summary ?? null);
  if ('required_photos' in parsed.data && typeof parsed.data.required_photos === 'boolean')
    patch.required_photos = parsed.data.required_photos;
  if ('due_date' in parsed.data) patch.due_date = emptyToNull(parsed.data.due_date ?? null);

  const { data, error } = await supabase
    .from('tasks')
    .update(patch)
    .eq('id', parsed.data.id)
    .select('id, job_id')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Task not found or not editable.' };
  }

  revalidatePath('/dashboard');
  revalidatePath('/todos');
  revalidateForJob(data.job_id as string | null);
  return { ok: true, id: data.id as string };
}

/**
 * Status-only transition. Whitelisted to `status` so worker-role callers
 * (whose RLS policy allows UPDATE on their assigned rows) can't
 * accidentally land changes to assignee/visibility/etc.
 *
 * Side-effects:
 *   - Moving to 'done' sets completed_at if not already set.
 *   - Moving to 'verified' sets verified_at if not already set.
 */
export async function changeStatusAction(input: {
  id: string;
  status: string;
}): Promise<TaskActionResult> {
  const parsed = taskStatusChangeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid status change.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  const { data: current, error: loadErr } = await supabase
    .from('tasks')
    .select('id, status, completed_at, verified_at, job_id')
    .eq('id', parsed.data.id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!current) return { ok: false, error: 'Task not found.' };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: parsed.data.status,
    updated_at: now,
  };
  if (parsed.data.status === 'done' && !current.completed_at) patch.completed_at = now;
  if (parsed.data.status === 'verified' && !current.verified_at) patch.verified_at = now;

  const { error: updateErr } = await supabase.from('tasks').update(patch).eq('id', parsed.data.id);

  if (updateErr) return { ok: false, error: updateErr.message };

  revalidatePath('/dashboard');
  revalidatePath('/todos');
  revalidateForJob(current.job_id as string | null);
  return { ok: true, id: parsed.data.id };
}

export async function assignTaskAction(input: {
  id: string;
  assignee_id: string | null;
}): Promise<TaskActionResult> {
  const parsed = taskAssignSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid assignment.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tasks')
    .update({ assignee_id: parsed.data.assignee_id, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.id)
    .select('id, job_id, title, tenant_id')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Task not found.' };
  }

  // Ping the newly assigned worker so the data path exists even though
  // push delivery isn't wired yet. TODO(phase-4): replace with real push.
  if (parsed.data.assignee_id) {
    await writeNotification({
      tenantId: data.tenant_id as string,
      recipientUserId: parsed.data.assignee_id,
      kind: 'task_assigned',
      taskId: data.id as string,
      jobId: (data.job_id as string | null) ?? null,
      title: 'New task assigned',
      body: (data.title as string) ?? null,
    });
  }

  revalidateForJob(data.job_id as string | null);
  revalidatePath('/dashboard');
  revalidatePath('/w/tasks');
  return { ok: true, id: data.id as string };
}

/**
 * Worker-only status change. Whitelists the worker status set, enforces
 * the blocker_reason rule, and pings the owner on done / blocked.
 *
 * RLS already restricts the UPDATE to rows where `assignee_id = auth.uid()`,
 * so a worker can only land this against their own assignment.
 */
export async function workerChangeTaskStatusAction(input: {
  id: string;
  status: string;
  blocker_reason?: string;
}): Promise<TaskActionResult> {
  if (!input.id || !input.status) return { ok: false, error: 'Missing task id or status.' };
  if (!WORKER_ALLOWED_STATUSES.has(input.status)) {
    return { ok: false, error: 'Workers cannot set that status.' };
  }
  if (input.status === 'blocked') {
    const reason = (input.blocker_reason ?? '').trim();
    if (reason.length < 5) {
      return { ok: false, error: 'Add a short blocker note (at least 5 characters).' };
    }
  }

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: current, error: loadErr } = await supabase
    .from('tasks')
    .select('id, status, completed_at, job_id, title, tenant_id, assignee_id')
    .eq('id', input.id)
    .maybeSingle();
  if (loadErr) return { ok: false, error: loadErr.message };
  if (!current) return { ok: false, error: 'Task not found or not assigned to you.' };

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    status: input.status,
    updated_at: now,
  };
  if (input.status === 'done' && !current.completed_at) patch.completed_at = now;
  if (input.status === 'blocked') patch.blocker_reason = (input.blocker_reason ?? '').trim();
  // Moving away from blocked clears the reason so stale notes don't linger.
  if (input.status !== 'blocked' && current.status === 'blocked') patch.blocker_reason = null;

  const { error: updateErr } = await supabase.from('tasks').update(patch).eq('id', input.id);
  if (updateErr) return { ok: false, error: updateErr.message };

  // Notify owners/admins.
  if (input.status === 'done' || input.status === 'blocked') {
    const ownerIds = await getOwnerAdminUserIds(current.tenant_id as string);
    await Promise.all(
      ownerIds.map((uid) =>
        writeNotification({
          tenantId: current.tenant_id as string,
          recipientUserId: uid,
          kind: input.status === 'done' ? 'task_done' : 'task_blocked',
          taskId: current.id as string,
          jobId: (current.job_id as string | null) ?? null,
          title: input.status === 'done' ? 'Task marked done' : 'Task blocked',
          body:
            input.status === 'blocked'
              ? (input.blocker_reason ?? '').trim()
              : (current.title as string),
        }),
      ),
    );
  }

  revalidatePath('/w/tasks');
  revalidatePath('/dashboard');
  revalidateForJob(current.job_id as string | null);
  return { ok: true, id: current.id as string };
}

/**
 * "Need Help" ping from a worker. Doesn't change task status — just drops
 * a notification row against every owner/admin in the tenant so they
 * can see the ask on their dashboard (or eventually on their phone).
 */
export async function workerNeedHelpAction(input: {
  id: string;
  note?: string;
}): Promise<TaskActionResult> {
  if (!input.id) return { ok: false, error: 'Missing task id.' };
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: current } = await supabase
    .from('tasks')
    .select('id, job_id, title, tenant_id')
    .eq('id', input.id)
    .maybeSingle();
  if (!current) return { ok: false, error: 'Task not found or not assigned to you.' };

  const ownerIds = await getOwnerAdminUserIds(current.tenant_id as string);
  await Promise.all(
    ownerIds.map((uid) =>
      writeNotification({
        tenantId: current.tenant_id as string,
        recipientUserId: uid,
        kind: 'task_help',
        taskId: current.id as string,
        jobId: (current.job_id as string | null) ?? null,
        title: 'Crew needs help',
        body: (input.note ?? (current.title as string)).trim() || (current.title as string),
      }),
    ),
  );
  return { ok: true, id: current.id as string };
}

/**
 * Owner/admin verifies a done task. Sets status='verified' and stamps
 * `verified_at`. Worker callers bounce.
 */
export async function verifyTaskAction(taskId: string): Promise<TaskActionResult> {
  if (!taskId) return { ok: false, error: 'Missing task id.' };
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only owners / admins can verify.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'verified', verified_at: now, updated_at: now })
    .eq('id', taskId)
    .select('id, job_id, title, assignee_id, tenant_id')
    .maybeSingle();

  if (error || !data) return { ok: false, error: error?.message ?? 'Task not found.' };

  if (data.assignee_id) {
    await writeNotification({
      tenantId: data.tenant_id as string,
      recipientUserId: data.assignee_id as string,
      kind: 'task_verified',
      taskId: data.id as string,
      jobId: (data.job_id as string | null) ?? null,
      title: 'Task verified',
      body: data.title as string,
    });
  }

  revalidatePath('/dashboard');
  revalidatePath('/w/tasks');
  revalidateForJob(data.job_id as string | null);
  return { ok: true, id: data.id as string };
}

/**
 * Owner/admin rejects a `done` task, pushing it back to `in_progress`
 * with an optional note appended as a worklog entry so there's a
 * paper trail for the crew.
 */
export async function rejectVerificationAction(
  taskId: string,
  note?: string,
): Promise<TaskActionResult> {
  if (!taskId) return { ok: false, error: 'Missing task id.' };
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only owners / admins can reject.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('tasks')
    .update({
      status: 'in_progress',
      verified_at: null,
      completed_at: null,
      updated_at: now,
    })
    .eq('id', taskId)
    .select('id, job_id, title, assignee_id, tenant_id')
    .maybeSingle();

  if (error || !data) return { ok: false, error: error?.message ?? 'Task not found.' };

  const trimmed = (note ?? '').trim();
  // Worklog entry: rejection note. Best-effort — the status flip already
  // landed so we don't fail the whole action if the worklog write trips.
  try {
    const admin = createAdminClient();
    await admin.from('worklog_entries').insert({
      tenant_id: data.tenant_id as string,
      entry_type: 'system',
      title: 'Task sent back for rework',
      body: trimmed || `"${data.title as string}" needs more work before verification.`,
      related_type: 'task',
      related_id: data.id as string,
    });
  } catch {
    // ignore
  }

  if (data.assignee_id) {
    await writeNotification({
      tenantId: data.tenant_id as string,
      recipientUserId: data.assignee_id as string,
      kind: 'task_rejected',
      taskId: data.id as string,
      jobId: (data.job_id as string | null) ?? null,
      title: 'Task sent back for rework',
      body: trimmed || (data.title as string),
    });
  }

  revalidatePath('/dashboard');
  revalidatePath('/w/tasks');
  revalidateForJob(data.job_id as string | null);
  return { ok: true, id: data.id as string };
}

export async function deleteTaskAction(id: string): Promise<TaskActionResult> {
  if (!id) return { ok: false, error: 'Missing task id.' };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('tasks')
    .delete()
    .eq('id', id)
    .select('id, job_id')
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Task not found or not deletable.' };

  revalidatePath('/dashboard');
  revalidatePath('/todos');
  revalidateForJob(data.job_id as string | null);
  return { ok: true, id: data.id as string };
}
