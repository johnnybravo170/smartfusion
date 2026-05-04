'use server';

/**
 * Server actions for time entry logging.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type TimeEntryActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const timeEntrySchema = z.object({
  project_id: z.string().uuid().optional().or(z.literal('')),
  job_id: z.string().uuid().optional().or(z.literal('')),
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  hours: z.coerce.number().positive({ message: 'Hours must be greater than 0.' }),
  hourly_rate_cents: z.coerce.number().int().optional(),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  entry_date: z.string().min(1, { message: 'Date is required.' }),
  confirm_empty: z.boolean().optional(),
});

const timeEntryUpdateSchema = timeEntrySchema.extend({
  id: z.string().uuid({ message: 'Invalid time entry id.' }),
});

// See worker-time.ts for the rationale — every entry needs a bucket or a
// note so labour can roll up to a cost line. Office surfaces show a confirm
// dialog and pass `confirm_empty: true` when the user chose to save anyway.
const EMPTY_CONTEXT_ERROR = 'Pick a work area or add a note so labour can be tracked.';

function hasContext(input: { budget_category_id?: string | null; notes?: string | null }): boolean {
  return Boolean(input.budget_category_id || input.notes?.trim());
}

export async function logTimeAction(input: {
  project_id?: string;
  job_id?: string;
  budget_category_id?: string;
  hours: number;
  hourly_rate_cents?: number;
  notes?: string;
  entry_date: string;
  confirm_empty?: boolean;
}): Promise<TimeEntryActionResult> {
  const parsed = timeEntrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const projectId = parsed.data.project_id || null;
  const jobId = parsed.data.job_id || null;
  if (!projectId && !jobId) {
    return { ok: false, error: 'A project or job is required.' };
  }

  if (!hasContext(parsed.data) && !parsed.data.confirm_empty) {
    return { ok: false, error: EMPTY_CONTEXT_ERROR };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not authenticated.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('time_entries')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      project_id: projectId,
      job_id: jobId,
      budget_category_id: parsed.data.budget_category_id || null,
      hours: parsed.data.hours,
      hourly_rate_cents: parsed.data.hourly_rate_cents ?? null,
      notes: parsed.data.notes?.trim() || null,
      entry_date: parsed.data.entry_date,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to log time.' };
  }

  if (projectId) revalidatePath(`/projects/${projectId}`);
  if (jobId) revalidatePath(`/jobs/${jobId}`);
  return { ok: true, id: data.id };
}

export async function updateTimeEntryAction(input: {
  id: string;
  project_id?: string;
  job_id?: string;
  budget_category_id?: string;
  hours: number;
  hourly_rate_cents?: number;
  notes?: string;
  entry_date: string;
  confirm_empty?: boolean;
}): Promise<TimeEntryActionResult> {
  const parsed = timeEntryUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  if (!hasContext(parsed.data) && !parsed.data.confirm_empty) {
    return { ok: false, error: EMPTY_CONTEXT_ERROR };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('time_entries')
    .update({
      project_id: parsed.data.project_id || null,
      job_id: parsed.data.job_id || null,
      budget_category_id: parsed.data.budget_category_id || null,
      hours: parsed.data.hours,
      hourly_rate_cents: parsed.data.hourly_rate_cents ?? null,
      notes: parsed.data.notes?.trim() || null,
      entry_date: parsed.data.entry_date,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  if (parsed.data.project_id) revalidatePath(`/projects/${parsed.data.project_id}`);
  if (parsed.data.job_id) revalidatePath(`/jobs/${parsed.data.job_id}`);
  return { ok: true, id: parsed.data.id };
}

export async function deleteTimeEntryAction(id: string): Promise<TimeEntryActionResult> {
  if (!id) return { ok: false, error: 'Missing time entry id.' };

  const supabase = await createClient();
  const { error } = await supabase.from('time_entries').delete().eq('id', id);

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id };
}

export async function listActiveProjectsAction(): Promise<
  | {
      ok: true;
      projects: {
        id: string;
        name: string;
        categories: { id: string; name: string; section: string }[];
      }[];
    }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('projects')
    .select(
      'id, name, project_budget_categories(id, name, section, display_order, is_visible_in_report)',
    )
    .is('deleted_at', null)
    .in('lifecycle_stage', ['planning', 'awaiting_approval', 'active'])
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return { ok: false, error: error.message };

  const projects = (
    (data ?? []) as Array<{
      id: string;
      name: string;
      project_budget_categories:
        | {
            id: string;
            name: string;
            section: string;
            display_order: number;
            is_visible_in_report: boolean;
          }[]
        | null;
    }>
  ).map((p) => ({
    id: p.id,
    name: p.name,
    categories: (p.project_budget_categories ?? [])
      .filter((c) => c.is_visible_in_report !== false)
      .sort(
        (a, b) =>
          (a.section ?? '').localeCompare(b.section ?? '') || a.display_order - b.display_order,
      )
      .map((c) => ({ id: c.id, name: c.name, section: c.section })),
  }));

  return { ok: true, projects };
}
