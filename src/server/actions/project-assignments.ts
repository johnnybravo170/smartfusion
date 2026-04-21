'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const createSchema = z.object({
  project_id: z.string().uuid(),
  worker_profile_id: z.string().uuid(),
  scheduled_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .nullable(),
  hourly_rate_dollars: z.string().trim().optional().default(''),
  notes: z.string().trim().max(500).optional().default(''),
});

function assertOwnerOrAdmin(role: string) {
  if (role !== 'owner' && role !== 'admin') {
    throw new Error('Only owners and admins can manage assignments.');
  }
}

export async function assignWorkerAction(
  input: z.input<typeof createSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }

  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };
  const v = parsed.data;

  const rateStr = v.hourly_rate_dollars.trim();
  const rateCents = rateStr === '' ? null : Math.round(Number(rateStr) * 100);
  if (rateCents !== null && (!Number.isFinite(rateCents) || rateCents < 0)) {
    return { ok: false, error: 'Rate must be a positive number.' };
  }

  const admin = createAdminClient();

  // Verify the worker belongs to this tenant.
  const { data: wp } = await admin
    .from('worker_profiles')
    .select('id')
    .eq('id', v.worker_profile_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!wp) return { ok: false, error: 'Worker not found in this tenant.' };

  const { error } = await admin.from('project_assignments').insert({
    tenant_id: tenant.id,
    project_id: v.project_id,
    worker_profile_id: v.worker_profile_id,
    scheduled_date: v.scheduled_date ?? null,
    hourly_rate_cents: rateCents,
    notes: v.notes || null,
  });
  if (error) {
    if (error.code === '23505') {
      return { ok: false, error: 'This worker is already assigned to that date.' };
    }
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${v.project_id}`);
  return { ok: true };
}

export async function removeAssignmentAction(
  assignmentId: string,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from('project_assignments')
    .select('project_id')
    .eq('id', assignmentId)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!existing) return { ok: false, error: 'Assignment not found.' };

  const { error } = await admin
    .from('project_assignments')
    .delete()
    .eq('id', assignmentId)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${existing.project_id}`);
  return { ok: true };
}
