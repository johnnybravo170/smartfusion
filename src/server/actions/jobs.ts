'use server';

/**
 * Server actions for the Jobs module.
 *
 * All mutations run through the RLS-aware server client so the tenant check
 * happens in the database. We still resolve the tenant via `getCurrentTenant`
 * because INSERT needs an explicit `tenant_id` (the RLS WITH CHECK guards it).
 *
 * Status transitions emit a `worklog_entries` row (see PHASE_1_PLAN.md §8
 * Track C). The worklog write is best-effort: if it fails after the status
 * update succeeds, we surface the error but the status change stays committed.
 *
 * Spec: PHASE_1_PLAN.md §8 Track C.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import {
  emptyToNull,
  type JobStatus,
  jobCreateSchema,
  jobStatusChangeSchema,
  jobStatusLabels,
  jobUpdateSchema,
} from '@/lib/validators/job';

export type JobActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type JobFormInput = {
  customer_id: string;
  quote_id?: string;
  status?: string;
  scheduled_at?: string;
  notes?: string;
};

/**
 * Convert a form's `datetime-local` string (e.g. `2026-04-20T09:00`) into an
 * ISO timestamp suitable for Postgres `timestamptz`. The browser submits
 * local wall-clock time without a zone. We let `new Date(...)` interpret it
 * in the runtime's local TZ and persist the UTC moment.
 */
function parseScheduledAt(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function createJobAction(input: JobFormInput): Promise<JobActionResult> {
  const parsed = jobCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('jobs')
    .insert({
      tenant_id: tenant.id,
      customer_id: parsed.data.customer_id,
      quote_id: emptyToNull(parsed.data.quote_id),
      status: parsed.data.status,
      scheduled_at: parseScheduledAt(parsed.data.scheduled_at),
      notes: emptyToNull(parsed.data.notes),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create job.' };
  }

  revalidatePath('/jobs');
  revalidatePath('/jobs/list');
  revalidatePath(`/customers/${parsed.data.customer_id}`);
  return { ok: true, id: data.id };
}

export async function updateJobAction(
  input: JobFormInput & { id: string },
): Promise<JobActionResult> {
  const parsed = jobUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('jobs')
    .update({
      customer_id: parsed.data.customer_id,
      quote_id: emptyToNull(parsed.data.quote_id),
      status: parsed.data.status,
      scheduled_at: parseScheduledAt(parsed.data.scheduled_at),
      notes: emptyToNull(parsed.data.notes),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/jobs');
  revalidatePath('/jobs/list');
  revalidatePath(`/jobs/${parsed.data.id}`);
  revalidatePath(`/customers/${parsed.data.customer_id}`);
  return { ok: true, id: parsed.data.id };
}

/**
 * Transition a job's status and log the transition to `worklog_entries`.
 *
 * Side-effects on the job row:
 *   - Moving TO `in_progress` sets `started_at = now()` (if not already set).
 *   - Moving TO `complete` sets `completed_at = now()` (if not already set).
 *
 * The worklog insert runs after the update. If it fails, the status change
 * is already committed; we surface the error so the caller can retry.
 */
export async function changeJobStatusAction(input: {
  id: string;
  status: string;
}): Promise<JobActionResult> {
  const parsed = jobStatusChangeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid status change.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // 1. Load the current job (old status, customer for the worklog body).
  const { data: current, error: loadErr } = await supabase
    .from('jobs')
    .select('id, status, started_at, completed_at, customer_id, customers:customer_id (id, name)')
    .eq('id', parsed.data.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, error: `Failed to load job: ${loadErr.message}` };
  }
  if (!current) {
    return { ok: false, error: 'Job not found.' };
  }

  const oldStatus = current.status as JobStatus;
  const newStatus = parsed.data.status;

  if (oldStatus === newStatus) {
    // No-op; still return success so the caller doesn't display an error.
    return { ok: true, id: parsed.data.id };
  }

  // 2. Build the update patch.
  const now = new Date().toISOString();
  const patch: Record<string, string> = {
    status: newStatus,
    updated_at: now,
  };
  if (newStatus === 'in_progress' && !current.started_at) {
    patch.started_at = now;
  }
  if (newStatus === 'complete' && !current.completed_at) {
    patch.completed_at = now;
  }

  const { error: updateErr } = await supabase
    .from('jobs')
    .update(patch)
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (updateErr) {
    return { ok: false, error: `Failed to update status: ${updateErr.message}` };
  }

  // 3. Write the worklog entry. Supabase returns the join as an array or an
  // object depending on the inferred cardinality; handle both.
  const customerRaw = current.customers;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const customerName =
    customer && typeof customer === 'object' && 'name' in customer
      ? (customer as { name: string }).name
      : 'customer';

  const { error: logErr } = await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Job status changed',
    body: `Job for ${customerName} moved from ${jobStatusLabels[oldStatus]} to ${jobStatusLabels[newStatus]}.`,
    related_type: 'job',
    related_id: parsed.data.id,
  });

  if (logErr) {
    // Status change succeeded; log failed. Surface but don't roll back.
    return {
      ok: false,
      error: `Status changed, but the worklog entry failed: ${logErr.message}`,
    };
  }

  revalidatePath('/jobs');
  revalidatePath('/jobs/list');
  revalidatePath(`/jobs/${parsed.data.id}`);
  return { ok: true, id: parsed.data.id };
}

/**
 * Soft-delete. `jobs.deleted_at` exists (migration 0018), so we set it and
 * leave the row in place to preserve history (invoices reference jobs).
 *
 * Returns to `/jobs` via redirect on success. Server-action redirects throw
 * a `NEXT_REDIRECT` error that the framework handles.
 */
export async function deleteJobAction(id: string): Promise<JobActionResult | never> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing job id.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('jobs')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/jobs');
  revalidatePath('/jobs/list');
  redirect('/jobs');
}
