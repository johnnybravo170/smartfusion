'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireWorker } from '@/lib/auth/helpers';
import {
  isWorkerAssignedToProject,
  listAssignmentsForProject,
} from '@/lib/db/queries/project-assignments';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export type WorkerTimeResult = { ok: true; id: string } | { ok: false; error: string };

const logSchema = z.object({
  project_id: z.string().uuid({ message: 'Pick a project.' }),
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  cost_line_id: z.string().uuid().optional().or(z.literal('')),
  hours: z.coerce.number().positive().max(24),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  entry_date: z.string().min(1),
  confirm_empty: z.boolean().optional(),
});

// Time entries with no bucket and no notes are unallocatable — the office
// can't roll labour up to a cost line. Require one or the other on every
// new/updated entry; client surfaces show a confirm dialog and pass
// `confirm_empty: true` if the worker chose to save anyway.
function hasContext(input: {
  budget_category_id?: string | null;
  cost_line_id?: string | null;
  notes?: string | null;
}): boolean {
  return Boolean(input.budget_category_id || input.cost_line_id || input.notes?.trim());
}

const EMPTY_CONTEXT_ERROR = 'Pick a work area or add a note so the office can track this.';

export async function logWorkerTimeAction(input: {
  project_id: string;
  budget_category_id?: string;
  cost_line_id?: string;
  hours: number;
  notes?: string;
  entry_date: string;
  confirm_empty?: boolean;
}): Promise<WorkerTimeResult> {
  const parsed = logSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  if (!hasContext(parsed.data) && !parsed.data.confirm_empty) {
    return { ok: false, error: EMPTY_CONTEXT_ERROR };
  }

  const { user, tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const assigned = await isWorkerAssignedToProject(tenant.id, profile.id, parsed.data.project_id);
  if (!assigned) return { ok: false, error: 'You are not assigned to this project.' };

  // Rate: prefer a day-specific or ongoing assignment override; else the
  // worker's default rate; else null.
  const assignments = await listAssignmentsForProject(tenant.id, parsed.data.project_id);
  const mine = assignments.filter((a) => a.worker_profile_id === profile.id);
  const dayMatch = mine.find((a) => a.scheduled_date === parsed.data.entry_date);
  const ongoing = mine.find((a) => a.scheduled_date === null);
  const payCents =
    dayMatch?.hourly_rate_cents ??
    ongoing?.hourly_rate_cents ??
    profile.default_hourly_rate_cents ??
    null;
  const chargeCents =
    dayMatch?.charge_rate_cents ??
    ongoing?.charge_rate_cents ??
    profile.default_charge_rate_cents ??
    null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('time_entries')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      worker_profile_id: profile.id,
      project_id: parsed.data.project_id,
      budget_category_id: parsed.data.budget_category_id || null,
      cost_line_id: parsed.data.cost_line_id || null,
      hours: parsed.data.hours,
      hourly_rate_cents: payCents,
      charge_rate_cents: chargeCents,
      notes: parsed.data.notes?.trim() || null,
      entry_date: parsed.data.entry_date,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to log time.' };

  revalidatePath('/w/time');
  revalidatePath('/w');
  revalidatePath(`/w/projects/${parsed.data.project_id}`);
  revalidatePath(`/projects/${parsed.data.project_id}`);
  return { ok: true, id: data.id };
}

const GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * Workers can always edit/delete their own entries within 48h of logging.
 * Beyond that, we check `tenants.workers_can_edit_old_entries`. Ownership
 * is verified in every path.
 */
async function canWorkerMutateEntry(
  tenantId: string,
  profileId: string,
  entryId: string,
): Promise<
  | { ok: true; entry: { id: string; project_id: string | null; created_at: string } }
  | { ok: false; error: string }
> {
  const admin = createAdminClient();
  const { data: entry } = await admin
    .from('time_entries')
    .select('id, worker_profile_id, project_id, created_at')
    .eq('id', entryId)
    .maybeSingle();

  if (!entry || entry.worker_profile_id !== profileId) {
    return { ok: false, error: 'Entry not found.' };
  }

  const ageMs = Date.now() - new Date(entry.created_at as string).getTime();
  if (ageMs <= GRACE_MS) {
    return {
      ok: true,
      entry: {
        id: entry.id as string,
        project_id: (entry.project_id as string | null) ?? null,
        created_at: entry.created_at as string,
      },
    };
  }

  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_edit_old_entries')
    .eq('id', tenantId)
    .maybeSingle();

  if (!tenantRow?.workers_can_edit_old_entries) {
    return {
      ok: false,
      error: 'This entry is older than 48 hours. Ask your supervisor to change it.',
    };
  }

  return {
    ok: true,
    entry: {
      id: entry.id as string,
      project_id: (entry.project_id as string | null) ?? null,
      created_at: entry.created_at as string,
    },
  };
}

const updateSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  budget_category_id: z.string().uuid().optional().or(z.literal('')),
  cost_line_id: z.string().uuid().optional().or(z.literal('')),
  hours: z.coerce.number().positive().max(24),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  entry_date: z.string().min(1),
  confirm_empty: z.boolean().optional(),
});

export async function updateWorkerTimeAction(input: {
  id: string;
  project_id: string;
  budget_category_id?: string;
  cost_line_id?: string;
  hours: number;
  notes?: string;
  entry_date: string;
  confirm_empty?: boolean;
}): Promise<WorkerTimeResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  if (!hasContext(parsed.data) && !parsed.data.confirm_empty) {
    return { ok: false, error: EMPTY_CONTEXT_ERROR };
  }

  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const check = await canWorkerMutateEntry(tenant.id, profile.id, parsed.data.id);
  if (!check.ok) return check;

  const assigned = await isWorkerAssignedToProject(tenant.id, profile.id, parsed.data.project_id);
  if (!assigned) return { ok: false, error: 'You are not assigned to this project.' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('time_entries')
    .update({
      project_id: parsed.data.project_id,
      budget_category_id: parsed.data.budget_category_id || null,
      cost_line_id: parsed.data.cost_line_id || null,
      hours: parsed.data.hours,
      notes: parsed.data.notes?.trim() || null,
      entry_date: parsed.data.entry_date,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/time');
  revalidatePath('/w');
  revalidatePath(`/w/projects/${parsed.data.project_id}`);
  revalidatePath(`/projects/${parsed.data.project_id}`);
  if (check.entry.project_id && check.entry.project_id !== parsed.data.project_id) {
    revalidatePath(`/projects/${check.entry.project_id}`);
  }
  return { ok: true, id: parsed.data.id };
}

export async function deleteWorkerTimeAction(id: string): Promise<WorkerTimeResult> {
  if (!id) return { ok: false, error: 'Missing id.' };
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const check = await canWorkerMutateEntry(tenant.id, profile.id, id);
  if (!check.ok) return check;

  const admin = createAdminClient();
  const { error } = await admin.from('time_entries').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/time');
  if (check.entry.project_id) revalidatePath(`/projects/${check.entry.project_id}`);
  return { ok: true, id };
}
