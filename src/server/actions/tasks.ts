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
import { createClient } from '@/lib/supabase/server';
import {
  taskAssignSchema,
  taskCreateSchema,
  taskStatusChangeSchema,
  taskUpdateSchema,
} from '@/lib/validators/task';

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
    .select('id, job_id')
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Task not found.' };
  }
  revalidateForJob(data.job_id as string | null);
  revalidatePath('/dashboard');
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
