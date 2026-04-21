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
  bucket_id: z.string().uuid().optional().or(z.literal('')),
  hours: z.coerce.number().positive().max(24),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  entry_date: z.string().min(1),
});

export async function logWorkerTimeAction(input: {
  project_id: string;
  bucket_id?: string;
  hours: number;
  notes?: string;
  entry_date: string;
}): Promise<WorkerTimeResult> {
  const parsed = logSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
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
      bucket_id: parsed.data.bucket_id || null,
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

export async function deleteWorkerTimeAction(id: string): Promise<WorkerTimeResult> {
  if (!id) return { ok: false, error: 'Missing id.' };
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();
  const { data: entry } = await admin
    .from('time_entries')
    .select('id, worker_profile_id, project_id, created_at')
    .eq('id', id)
    .maybeSingle();

  if (!entry || entry.worker_profile_id !== profile.id) {
    return { ok: false, error: 'Entry not found.' };
  }

  const ageMs = Date.now() - new Date(entry.created_at as string).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) {
    return { ok: false, error: 'Entries can only be deleted within 24 hours.' };
  }

  const { error } = await admin.from('time_entries').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/time');
  if (entry.project_id) revalidatePath(`/projects/${entry.project_id}`);
  return { ok: true, id };
}
