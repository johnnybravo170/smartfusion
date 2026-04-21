'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const addSchema = z.object({
  worker_profile_id: z.string().uuid(),
  dates: z.array(z.string().regex(DATE_RE)).min(1).max(120),
  reason_tag: z.enum(['vacation', 'sick', 'other_job', 'personal', 'other']),
  reason_text: z.string().trim().max(500).optional().default(''),
});

export type UnavailabilityResult = { ok: true } | { ok: false; error: string };

export async function addUnavailabilityAction(
  input: z.input<typeof addSchema>,
): Promise<UnavailabilityResult> {
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  // Authorisation: owner/admin may mark any tenant worker; workers only themselves.
  if (tenant.member.role === 'worker') {
    const myProfile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
    if (myProfile.id !== parsed.data.worker_profile_id) {
      return { ok: false, error: 'You can only mark your own unavailability.' };
    }
  } else if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Not allowed.' };
  }

  // Verify worker belongs to this tenant.
  const { data: wp } = await admin
    .from('worker_profiles')
    .select('id')
    .eq('id', parsed.data.worker_profile_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!wp) return { ok: false, error: 'Worker not found.' };

  const rows = parsed.data.dates.map((d) => ({
    tenant_id: tenant.id,
    worker_profile_id: parsed.data.worker_profile_id,
    unavailable_date: d,
    reason_tag: parsed.data.reason_tag,
    reason_text: parsed.data.reason_text || null,
    created_by: user.id,
  }));

  // Ignore duplicates quietly — unique constraint handles conflicts.
  const { error } = await admin
    .from('worker_unavailability')
    .upsert(rows, { onConflict: 'worker_profile_id,unavailable_date', ignoreDuplicates: true });

  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/calendar');
  revalidatePath('/w');
  revalidatePath('/settings/team');
  return { ok: true };
}

const removeSchema = z.object({
  worker_profile_id: z.string().uuid(),
  unavailable_date: z.string().regex(DATE_RE),
});

export async function removeUnavailabilityAction(
  input: z.input<typeof removeSchema>,
): Promise<UnavailabilityResult> {
  const parsed = removeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  if (tenant.member.role === 'worker') {
    const myProfile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
    if (myProfile.id !== parsed.data.worker_profile_id) {
      return { ok: false, error: 'Not allowed.' };
    }
  } else if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Not allowed.' };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('worker_unavailability')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('worker_profile_id', parsed.data.worker_profile_id)
    .eq('unavailable_date', parsed.data.unavailable_date);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/calendar');
  revalidatePath('/w');
  revalidatePath('/settings/team');
  return { ok: true };
}

const bulkRemoveSchema = z.object({
  worker_profile_id: z.string().uuid(),
  dates: z.array(z.string().regex(DATE_RE)).min(1).max(120),
});

export async function removeUnavailabilityRangeAction(
  input: z.input<typeof bulkRemoveSchema>,
): Promise<UnavailabilityResult> {
  const parsed = bulkRemoveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  if (tenant.member.role === 'worker') {
    const myProfile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
    if (myProfile.id !== parsed.data.worker_profile_id) {
      return { ok: false, error: 'Not allowed.' };
    }
  } else if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Not allowed.' };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from('worker_unavailability')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('worker_profile_id', parsed.data.worker_profile_id)
    .in('unavailable_date', parsed.data.dates);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/w/calendar');
  revalidatePath('/w');
  revalidatePath('/settings/team');
  return { ok: true };
}

const moveSchema = z.object({
  worker_profile_id: z.string().uuid(),
  from_dates: z.array(z.string().regex(DATE_RE)).min(1).max(120),
  to_dates: z.array(z.string().regex(DATE_RE)).min(1).max(120),
  reason_tag: z.enum(['vacation', 'sick', 'other_job', 'personal', 'other']),
  reason_text: z.string().trim().max(500).optional().default(''),
});

export async function moveUnavailabilityRangeAction(
  input: z.input<typeof moveSchema>,
): Promise<UnavailabilityResult> {
  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };
  if (parsed.data.from_dates.length !== parsed.data.to_dates.length) {
    return { ok: false, error: 'Date arrays must match in length.' };
  }

  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  if (tenant.member.role === 'worker') {
    const myProfile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
    if (myProfile.id !== parsed.data.worker_profile_id) {
      return { ok: false, error: 'Not allowed.' };
    }
  } else if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Not allowed.' };
  }

  const admin = createAdminClient();

  const { error: delErr } = await admin
    .from('worker_unavailability')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('worker_profile_id', parsed.data.worker_profile_id)
    .in('unavailable_date', parsed.data.from_dates);
  if (delErr) return { ok: false, error: delErr.message };

  const rows = parsed.data.to_dates.map((d) => ({
    tenant_id: tenant.id,
    worker_profile_id: parsed.data.worker_profile_id,
    unavailable_date: d,
    reason_tag: parsed.data.reason_tag,
    reason_text: parsed.data.reason_text || null,
    created_by: user.id,
  }));
  const { error: insErr } = await admin
    .from('worker_unavailability')
    .upsert(rows, { onConflict: 'worker_profile_id,unavailable_date', ignoreDuplicates: true });
  if (insErr) return { ok: false, error: insErr.message };

  revalidatePath('/w/calendar');
  revalidatePath('/w');
  revalidatePath('/settings/team');
  return { ok: true };
}
