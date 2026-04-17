'use server';

/**
 * Server actions for the Projects module (renovation vertical).
 *
 * All mutations run through the RLS-aware server client. Status transitions
 * emit worklog_entries rows. Soft-delete preserves history.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import {
  emptyToNull,
  type ProjectStatus,
  projectCreateSchema,
  projectStatusChangeSchema,
  projectStatusLabels,
  projectUpdateSchema,
} from '@/lib/validators/project';

export type ProjectActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/** Jon's default interior cost buckets. */
const DEFAULT_INTERIOR_BUCKETS = [
  'Demo',
  'Disposal',
  'Framing',
  'Plumbing',
  'Plumbing Fixtures',
  'HVAC',
  'Insulation',
  'Drywall',
  'Flooring',
  'Doors & Mouldings',
  'Windows & Doors',
  'Railings',
  'Electrical',
  'Painting',
  'Kitchen',
  'Contingency',
];

/** Jon's default exterior cost buckets. */
const DEFAULT_EXTERIOR_BUCKETS = [
  'Demo',
  'Disposal',
  'Framing',
  'Siding',
  'Sheathing',
  'Painting',
  'Gutters',
  'Front Garden',
  'Front Door',
  'Rot Repair',
  'Garage Doors',
  'Contingency',
];

export async function createProjectAction(input: {
  customer_id: string;
  name: string;
  description?: string;
  start_date?: string;
  target_end_date?: string;
  management_fee_rate?: number;
}): Promise<ProjectActionResult> {
  const parsed = projectCreateSchema.safeParse(input);
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
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: parsed.data.customer_id,
      name: parsed.data.name,
      description: emptyToNull(parsed.data.description),
      start_date: emptyToNull(parsed.data.start_date),
      target_end_date: emptyToNull(parsed.data.target_end_date),
      management_fee_rate: parsed.data.management_fee_rate,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create project.' };
  }

  // Seed default cost buckets
  const bucketRows = [
    ...DEFAULT_INTERIOR_BUCKETS.map((name, i) => ({
      project_id: data.id,
      tenant_id: tenant.id,
      name,
      section: 'interior' as const,
      display_order: i,
    })),
    ...DEFAULT_EXTERIOR_BUCKETS.map((name, i) => ({
      project_id: data.id,
      tenant_id: tenant.id,
      name,
      section: 'exterior' as const,
      display_order: DEFAULT_INTERIOR_BUCKETS.length + i,
    })),
  ];

  const { error: bucketErr } = await supabase.from('project_cost_buckets').insert(bucketRows);

  if (bucketErr) {
    // Project created but buckets failed. Still return success so the user
    // can seed manually.
    console.error('Failed to seed default buckets:', bucketErr.message);
  }

  // Write worklog entry
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project created',
    body: `Project "${parsed.data.name}" created.`,
    related_type: 'project',
    related_id: data.id,
  });

  revalidatePath('/projects');
  return { ok: true, id: data.id };
}

export async function updateProjectAction(input: {
  id: string;
  customer_id: string;
  name: string;
  description?: string;
  start_date?: string;
  target_end_date?: string;
  management_fee_rate?: number;
  status?: string;
  phase?: string;
  percent_complete?: number;
}): Promise<ProjectActionResult> {
  const parsed = projectUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({
      customer_id: parsed.data.customer_id,
      name: parsed.data.name,
      description: emptyToNull(parsed.data.description),
      start_date: emptyToNull(parsed.data.start_date),
      target_end_date: emptyToNull(parsed.data.target_end_date),
      management_fee_rate: parsed.data.management_fee_rate,
      status: parsed.data.status,
      phase: emptyToNull(parsed.data.phase),
      percent_complete: parsed.data.percent_complete,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/projects');
  revalidatePath(`/projects/${parsed.data.id}`);
  return { ok: true, id: parsed.data.id };
}

export async function updateProjectStatusAction(input: {
  id: string;
  status: string;
}): Promise<ProjectActionResult> {
  const parsed = projectStatusChangeSchema.safeParse(input);
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

  const { data: current, error: loadErr } = await supabase
    .from('projects')
    .select('id, status, name')
    .eq('id', parsed.data.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, error: `Failed to load project: ${loadErr.message}` };
  }
  if (!current) {
    return { ok: false, error: 'Project not found.' };
  }

  const oldStatus = current.status as ProjectStatus;
  const newStatus = parsed.data.status;

  if (oldStatus === newStatus) {
    return { ok: true, id: parsed.data.id };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('projects')
    .update({ status: newStatus, updated_at: now })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (updateErr) {
    return { ok: false, error: `Failed to update status: ${updateErr.message}` };
  }

  // Worklog entry
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project status changed',
    body: `Project "${current.name}" moved from ${projectStatusLabels[oldStatus]} to ${projectStatusLabels[newStatus]}.`,
    related_type: 'project',
    related_id: parsed.data.id,
  });

  revalidatePath('/projects');
  revalidatePath(`/projects/${parsed.data.id}`);
  return { ok: true, id: parsed.data.id };
}

export async function deleteProjectAction(id: string): Promise<ProjectActionResult | never> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing project id.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/projects');
  redirect('/projects');
}
