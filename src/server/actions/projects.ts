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
  type LifecycleStage,
  lifecycleStageChangeSchema,
  lifecycleStageLabels,
  projectCreateSchema,
  projectUpdateSchema,
} from '@/lib/validators/project';

export type ProjectActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

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

  // Auto-assign crew if the tenant preference is on
  const { data: tenantPrefs } = await supabase
    .from('tenants')
    .select('auto_assign_crew')
    .eq('id', tenant.id)
    .single();

  if (tenantPrefs?.auto_assign_crew) {
    const { data: workers } = await supabase
      .from('worker_profiles')
      .select('id')
      .eq('tenant_id', tenant.id);

    if (workers && workers.length > 0) {
      await supabase.from('project_assignments').insert(
        workers.map((w) => ({
          tenant_id: tenant.id,
          project_id: data.id,
          worker_profile_id: w.id,
        })),
      );
    }
  }

  // No auto-seed of categories. The budget tab shows a starter
  // template picker when scope is empty — operator picks a template
  // (or builds from scratch) instead of inheriting 28 boilerplate
  // categories they may not need.

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

  // Lifecycle stage is NOT updated here — it only moves via the named
  // transition actions (transitionLifecycleStageAction, putOnHoldAction,
  // resumeProjectAction) so we always have a paper trail.
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

export async function renameProjectAction(input: {
  id: string;
  name: string;
}): Promise<ProjectActionResult> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Name is required.' };
  if (name.length > 200) return { ok: false, error: 'Name too long.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ name, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .is('deleted_at', null);

  if (error) return { ok: false, error: error.message };

  revalidatePath('/projects');
  revalidatePath(`/projects/${input.id}`);
  return { ok: true, id: input.id };
}

/**
 * Patch just the start_date — used by the Schedule tab editor (which
 * anchors the Gantt timeline to this date) and by Henry's update_project
 * tool. `null` clears the value. Single-field action so neither caller
 * has to reconstruct the full project record.
 */
export async function updateProjectStartDateAction(input: {
  id: string;
  start_date: string | null;
}): Promise<ProjectActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ start_date: input.start_date, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .is('deleted_at', null);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/projects');
  revalidatePath(`/projects/${input.id}`);
  return { ok: true, id: input.id };
}

export async function updateProjectManagementFeeAction(input: {
  id: string;
  rate: number;
}): Promise<ProjectActionResult> {
  if (!Number.isFinite(input.rate) || input.rate < 0 || input.rate > 1) {
    return { ok: false, error: 'Fee rate must be between 0% and 100%.' };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not authenticated.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('projects')
    .select('name, management_fee_rate')
    .eq('id', input.id)
    .is('deleted_at', null)
    .single();
  if (!existing) return { ok: false, error: 'Project not found.' };

  const oldPct = Math.round(Number(existing.management_fee_rate ?? 0) * 1000) / 10;
  const newPct = Math.round(input.rate * 1000) / 10;
  if (oldPct === newPct) return { ok: true, id: input.id };

  const { error } = await supabase
    .from('projects')
    .update({ management_fee_rate: input.rate, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .is('deleted_at', null);

  if (error) return { ok: false, error: error.message };

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Management fee changed',
    body: `Management fee on "${existing.name}" changed from ${oldPct}% to ${newPct}%.`,
    related_type: 'project',
    related_id: input.id,
  });

  revalidatePath('/projects');
  revalidatePath(`/projects/${input.id}`);
  return { ok: true, id: input.id };
}

/**
 * Toggle the project's billing mode (cost-plus vs fixed-price). Drives
 * `generateFinalInvoiceAction`'s path selection and the auto-split tax
 * chip on expense forms. Writes a worklog entry — flipping this on a
 * live job is a meaningful operator decision worth tracing.
 */
export async function updateProjectIsCostPlusAction(input: {
  id: string;
  isCostPlus: boolean;
}): Promise<ProjectActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not authenticated.' };

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from('projects')
    .select('name, is_cost_plus')
    .eq('id', input.id)
    .is('deleted_at', null)
    .single();
  if (!existing) return { ok: false, error: 'Project not found.' };

  const oldVal = existing.is_cost_plus !== false;
  if (oldVal === input.isCostPlus) return { ok: true, id: input.id };

  const { error } = await supabase
    .from('projects')
    .update({ is_cost_plus: input.isCostPlus, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .is('deleted_at', null);

  if (error) return { ok: false, error: error.message };

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Billing mode changed',
    body: `Billing mode on "${existing.name}" changed from ${oldVal ? 'cost-plus' : 'fixed-price'} to ${input.isCostPlus ? 'cost-plus' : 'fixed-price'}.`,
    related_type: 'project',
    related_id: input.id,
  });

  revalidatePath('/projects');
  revalidatePath(`/projects/${input.id}`);
  return { ok: true, id: input.id };
}

/**
 * Move a project through its lifecycle. The only sanctioned way to change
 * `lifecycle_stage` outside of the estimate-approval flow. Writes a
 * worklog entry so there's a paper trail.
 *
 * Note: `awaiting_approval` and `declined` are owned by the estimate flow
 * (sendEstimate / approveEstimate / declineEstimate). This action can
 * still move TO / FROM them (e.g. mark a sent estimate as complete without
 * waiting on the customer, or back out of an accidental transition), but
 * the common path for those is through the estimate actions.
 */
export async function transitionLifecycleStageAction(input: {
  id: string;
  stage: LifecycleStage;
}): Promise<ProjectActionResult> {
  const parsed = lifecycleStageChangeSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid stage change.',
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
    .select('id, lifecycle_stage, name')
    .eq('id', parsed.data.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, error: `Failed to load project: ${loadErr.message}` };
  }
  if (!current) {
    return { ok: false, error: 'Project not found.' };
  }

  const oldStage = current.lifecycle_stage as LifecycleStage;
  const newStage = parsed.data.stage;

  if (oldStage === newStage) {
    return { ok: true, id: parsed.data.id };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('projects')
    .update({
      lifecycle_stage: newStage,
      // Clear any on-hold memory if we're not transitioning into on_hold.
      resumed_from_stage: newStage === 'on_hold' ? oldStage : null,
      updated_at: now,
    })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (updateErr) {
    return { ok: false, error: `Failed to update stage: ${updateErr.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project status changed',
    body: `Project "${current.name}" moved from ${lifecycleStageLabels[oldStage]} to ${lifecycleStageLabels[newStage]}.`,
    related_type: 'project',
    related_id: parsed.data.id,
  });

  revalidatePath('/projects');
  revalidatePath(`/projects/${parsed.data.id}`);
  return { ok: true, id: parsed.data.id };
}

/**
 * Resume an on-hold project back to the stage it was in before the hold.
 * Falls back to `planning` if the pre-hold stage is missing (shouldn't
 * happen, but defensive).
 */
export async function resumeProjectAction(input: { id: string }): Promise<ProjectActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();
  const { data: current, error: loadErr } = await supabase
    .from('projects')
    .select('id, lifecycle_stage, resumed_from_stage, name')
    .eq('id', input.id)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr) return { ok: false, error: loadErr.message };
  if (!current) return { ok: false, error: 'Project not found.' };

  if (current.lifecycle_stage !== 'on_hold') {
    return { ok: false, error: 'Project is not on hold.' };
  }

  const target = (current.resumed_from_stage as LifecycleStage | null) ?? 'planning';
  return transitionLifecycleStageAction({ id: input.id, stage: target });
}

export async function cloneProjectAction(input: {
  source_id: string;
  customer_id: string;
  name: string;
  clone_budget_categories: boolean;
  clone_notes: boolean;
  keep_line_photos?: boolean;
}): Promise<ProjectActionResult> {
  if (!input.source_id) return { ok: false, error: 'Missing source project id.' };
  if (!input.customer_id) return { ok: false, error: 'Pick a customer.' };
  const name = input.name.trim();
  if (!name) return { ok: false, error: 'Project name is required.' };

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: source, error: srcErr } = await supabase
    .from('projects')
    .select('description, start_date, target_end_date, management_fee_rate')
    .eq('id', input.source_id)
    .is('deleted_at', null)
    .single();

  if (srcErr || !source) {
    return { ok: false, error: srcErr?.message ?? 'Source project not found.' };
  }

  const { data: created, error: insErr } = await supabase
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: input.customer_id,
      name,
      description: source.description,
      start_date: null,
      target_end_date: null,
      management_fee_rate: source.management_fee_rate,
    })
    .select('id')
    .single();

  if (insErr || !created) {
    return { ok: false, error: insErr?.message ?? 'Failed to create project.' };
  }

  // Auto-assign crew if the tenant preference is on (matches createProjectAction).
  const { data: tenantPrefs } = await supabase
    .from('tenants')
    .select('auto_assign_crew')
    .eq('id', tenant.id)
    .single();

  if (tenantPrefs?.auto_assign_crew) {
    const { data: workers } = await supabase
      .from('worker_profiles')
      .select('id')
      .eq('tenant_id', tenant.id);

    if (workers && workers.length > 0) {
      await supabase.from('project_assignments').insert(
        workers.map((w) => ({
          tenant_id: tenant.id,
          project_id: created.id,
          worker_profile_id: w.id,
        })),
      );
    }
  }

  if (input.clone_budget_categories) {
    const { data: srcCategories } = await supabase
      .from('project_budget_categories')
      .select('id, name, section, description, estimate_cents, display_order, is_visible_in_report')
      .eq('project_id', input.source_id);

    // Pre-generate new category UUIDs so we can remap cost-line category ids
    // without a second round-trip to read back inserted rows.
    const categoryIdMap = new Map<string, string>();
    if (srcCategories && srcCategories.length > 0) {
      const rows = srcCategories.map((b) => {
        const newId = crypto.randomUUID();
        categoryIdMap.set(b.id, newId);
        return {
          id: newId,
          tenant_id: tenant.id,
          project_id: created.id,
          name: b.name,
          section: b.section,
          description: b.description,
          estimate_cents: b.estimate_cents,
          display_order: b.display_order,
          is_visible_in_report: b.is_visible_in_report,
        };
      });
      const { error: bErr } = await supabase.from('project_budget_categories').insert(rows);
      if (bErr) console.error('Failed to clone budget categories:', bErr.message);
    }

    // Estimate line items live on project_cost_lines, keyed by budget_category_id.
    // Without these, cloned projects show empty categories with no prices.
    const { data: srcLines } = await supabase
      .from('project_cost_lines')
      .select(
        'budget_category_id, catalog_item_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, markup_pct, line_cost_cents, line_price_cents, sort_order, notes, photo_storage_paths',
      )
      .eq('project_id', input.source_id);

    if (srcLines && srcLines.length > 0) {
      const lineRows = srcLines.map((l) => ({
        ...l,
        tenant_id: tenant.id,
        project_id: created.id,
        budget_category_id: l.budget_category_id
          ? (categoryIdMap.get(l.budget_category_id) ?? null)
          : null,
        photo_storage_paths: input.keep_line_photos ? l.photo_storage_paths : [],
      }));
      const { error: lErr } = await supabase.from('project_cost_lines').insert(lineRows);
      if (lErr) console.error('Failed to clone cost lines:', lErr.message);
    }
  }

  if (input.clone_notes) {
    const { data: srcNotes } = await supabase
      .from('project_notes')
      .select('body, user_id')
      .eq('project_id', input.source_id);

    if (srcNotes && srcNotes.length > 0) {
      const rows = srcNotes.map((n) => ({
        ...n,
        tenant_id: tenant.id,
        project_id: created.id,
      }));
      const { error: nErr } = await supabase.from('project_notes').insert(rows);
      if (nErr) console.error('Failed to clone project notes:', nErr.message);
    }
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Project cloned',
    body: `Project "${name}" cloned from ${input.source_id}.`,
    related_type: 'project',
    related_id: created.id,
  });

  revalidatePath('/projects');
  return { ok: true, id: created.id };
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
