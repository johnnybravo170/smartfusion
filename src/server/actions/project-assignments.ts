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
  pay_rate_dollars: z.string().trim().optional().default(''),
  charge_rate_dollars: z.string().trim().optional().default(''),
  notes: z.string().trim().max(500).optional().default(''),
});

function parseRate(input: string, label: string): { cents: number | null; error?: string } {
  const v = input.trim();
  if (v === '') return { cents: null };
  const cents = Math.round(Number(v) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    return { cents: null, error: `${label} must be a positive number.` };
  }
  return { cents };
}

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

  const pay = parseRate(v.pay_rate_dollars, 'Pay rate');
  if (pay.error) return { ok: false, error: pay.error };
  const charge = parseRate(v.charge_rate_dollars, 'Charge rate');
  if (charge.error) return { ok: false, error: charge.error };

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
    hourly_rate_cents: pay.cents,
    charge_rate_cents: charge.cents,
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const bulkAssignSchema = z.object({
  project_id: z.string().uuid(),
  worker_profile_id: z.string().uuid(),
  dates: z.array(z.string().regex(DATE_RE)).min(1).max(60),
});

/**
 * Bulk-assign a worker to a project for a set of specific dates.
 * Existing assignments for those dates are silently ignored (upsert).
 */
export async function bulkAssignDatesAction(
  input: z.input<typeof bulkAssignSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }

  const parsed = bulkAssignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };
  const v = parsed.data;

  const admin = createAdminClient();

  const { data: wp } = await admin
    .from('worker_profiles')
    .select('id')
    .eq('id', v.worker_profile_id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();
  if (!wp) return { ok: false, error: 'Worker not found in this tenant.' };

  // Delete any existing day-assignments for those dates first so the insert
  // is idempotent — partial unique indexes aren't usable by PostgREST upsert.
  await admin
    .from('project_assignments')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('project_id', v.project_id)
    .eq('worker_profile_id', v.worker_profile_id)
    .in('scheduled_date', v.dates);

  const rows = v.dates.map((d) => ({
    tenant_id: tenant.id,
    project_id: v.project_id,
    worker_profile_id: v.worker_profile_id,
    scheduled_date: d,
  }));

  const { error } = await admin.from('project_assignments').insert(rows);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${v.project_id}`);
  revalidatePath('/calendar');
  return { ok: true };
}

const moveSchema = z.object({
  project_id: z.string().uuid(),
  worker_profile_id: z.string().uuid(),
  from_dates: z.array(z.string().regex(DATE_RE)).min(1).max(60),
  to_dates: z.array(z.string().regex(DATE_RE)).min(1).max(60),
});

export async function moveAssignmentsAction(
  input: z.input<typeof moveSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }

  const parsed = moveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };
  const v = parsed.data;
  if (v.from_dates.length !== v.to_dates.length) {
    return { ok: false, error: 'Date arrays must match in length.' };
  }

  const admin = createAdminClient();

  // Read existing rows to preserve rate/notes on the new rows.
  const { data: oldRows } = await admin
    .from('project_assignments')
    .select('scheduled_date, hourly_rate_cents, charge_rate_cents, notes')
    .eq('tenant_id', tenant.id)
    .eq('project_id', v.project_id)
    .eq('worker_profile_id', v.worker_profile_id)
    .in('scheduled_date', v.from_dates);

  const byDate = new Map(
    (oldRows ?? []).map((r) => [
      r.scheduled_date as string,
      {
        hourly_rate_cents: r.hourly_rate_cents as number | null,
        charge_rate_cents: r.charge_rate_cents as number | null,
        notes: r.notes as string | null,
      },
    ]),
  );

  // Delete original day-scheduled rows.
  const { error: delErr } = await admin
    .from('project_assignments')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('project_id', v.project_id)
    .eq('worker_profile_id', v.worker_profile_id)
    .in('scheduled_date', v.from_dates);
  if (delErr) return { ok: false, error: delErr.message };

  // Insert at the new dates with preserved fields.
  const newRows = v.from_dates.map((d, i) => {
    const src = byDate.get(d);
    return {
      tenant_id: tenant.id,
      project_id: v.project_id,
      worker_profile_id: v.worker_profile_id,
      scheduled_date: v.to_dates[i],
      hourly_rate_cents: src?.hourly_rate_cents ?? null,
      charge_rate_cents: src?.charge_rate_cents ?? null,
      notes: src?.notes ?? null,
    };
  });
  const { error: insErr } = await admin.from('project_assignments').insert(newRows);
  if (insErr) {
    if (insErr.code === '23505') {
      return { ok: false, error: 'One of the target dates is already booked for this worker.' };
    }
    return { ok: false, error: insErr.message };
  }

  revalidatePath(`/projects/${v.project_id}`);
  revalidatePath('/calendar');
  return { ok: true };
}

const bulkDeleteSchema = z.object({
  project_id: z.string().uuid(),
  worker_profile_id: z.string().uuid(),
  dates: z.array(z.string().regex(DATE_RE)).min(1).max(60),
});

export async function deleteAssignmentsByDatesAction(
  input: z.input<typeof bulkDeleteSchema>,
): Promise<{ ok: boolean; error?: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  try {
    assertOwnerOrAdmin(tenant.member.role);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Forbidden.' };
  }

  const parsed = bulkDeleteSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };
  const v = parsed.data;

  const admin = createAdminClient();
  const { error } = await admin
    .from('project_assignments')
    .delete()
    .eq('tenant_id', tenant.id)
    .eq('project_id', v.project_id)
    .eq('worker_profile_id', v.worker_profile_id)
    .in('scheduled_date', v.dates);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${v.project_id}`);
  revalidatePath('/calendar');
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
  revalidatePath('/calendar');
  return { ok: true };
}
