'use server';

/**
 * Customer-facing view mode + sections for projects.
 *
 * The internal budget (categories + cost lines) is unchanged. This is the
 * presentation layer that decides how much of it the customer sees:
 *
 *   lump_sum  → one number + a summary narrative
 *   sections  → customer-facing groupings of multiple internal categories
 *   categories → every internal category visible
 *   detailed   → every cost line broken out
 *
 * Per Decision "Variance display derived from customer_view_mode" — the
 * mode also determines whether projected-vs-actual variance is exposed.
 * lump_sum + sections suppress it; categories + detailed show it. No
 * separate toggle.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { customerViewModes } from '@/lib/validators/project-customer-view';

type ProjectCustomerViewResult = { ok: true } | { ok: false; error: string };
type ProjectCustomerViewCreateResult = { ok: true; id: string } | { ok: false; error: string };

const viewModeSchema = z.object({
  projectId: z.string().uuid(),
  mode: z.enum(customerViewModes),
});

const summarySchema = z.object({
  projectId: z.string().uuid(),
  summaryMd: z.string().max(20000).nullable(),
});

const sectionCreateSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1, { message: 'Section name is required.' }).max(200),
  descriptionMd: z.string().max(20000).nullable().optional(),
});

const sectionUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, { message: 'Section name is required.' }).max(200).optional(),
  descriptionMd: z.string().max(20000).nullable().optional(),
});

const sectionReorderSchema = z.object({
  projectId: z.string().uuid(),
  sectionIds: z.array(z.string().uuid()).min(1),
});

const categoryAssignSchema = z.object({
  categoryId: z.string().uuid(),
  sectionId: z.string().uuid().nullable(),
});

export async function updateCustomerViewModeAction(
  input: z.input<typeof viewModeSchema>,
): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = viewModeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({ customer_view_mode: parsed.data.mode, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

export async function updateCustomerSummaryAction(
  input: z.input<typeof summarySchema>,
): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = summarySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('projects')
    .update({
      customer_summary_md: parsed.data.summaryMd?.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.projectId);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

export async function createCustomerSectionAction(
  input: z.input<typeof sectionCreateSchema>,
): Promise<ProjectCustomerViewCreateResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = sectionCreateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();

  // Append to end: sort_order = max + 1 (or 0 for first).
  const { data: maxRow } = await supabase
    .from('project_customer_sections')
    .select('sort_order')
    .eq('project_id', parsed.data.projectId)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((maxRow?.sort_order as number | undefined) ?? -1) + 1;

  const { data, error } = await supabase
    .from('project_customer_sections')
    .insert({
      tenant_id: tenant.id,
      project_id: parsed.data.projectId,
      name: parsed.data.name,
      description_md: parsed.data.descriptionMd ?? null,
      sort_order: nextOrder,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create section.' };
  }

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true, id: data.id as string };
}

export async function updateCustomerSectionAction(
  input: z.input<typeof sectionUpdateSchema>,
): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = sectionUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.descriptionMd !== undefined) {
    patch.description_md = parsed.data.descriptionMd?.trim() || null;
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_customer_sections')
    .update(patch)
    .eq('id', parsed.data.id)
    .select('project_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to update section.' };
  }

  revalidatePath(`/projects/${data.project_id as string}`);
  return { ok: true };
}

export async function deleteCustomerSectionAction(input: {
  id: string;
}): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!input.id || typeof input.id !== 'string') {
    return { ok: false, error: 'Invalid section id.' };
  }

  const supabase = await createClient();
  // Look up project_id before delete so we can revalidate the right path.
  const { data: existing } = await supabase
    .from('project_customer_sections')
    .select('project_id')
    .eq('id', input.id)
    .single();

  const { error } = await supabase.from('project_customer_sections').delete().eq('id', input.id);
  if (error) return { ok: false, error: error.message };

  if (existing?.project_id) {
    revalidatePath(`/projects/${existing.project_id as string}`);
  }
  return { ok: true };
}

export async function reorderCustomerSectionsAction(
  input: z.input<typeof sectionReorderSchema>,
): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = sectionReorderSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  // Update each row's sort_order. Could be batched via RPC; small N makes
  // serial updates fine.
  for (let i = 0; i < parsed.data.sectionIds.length; i++) {
    const id = parsed.data.sectionIds[i];
    const { error } = await supabase
      .from('project_customer_sections')
      .update({ sort_order: i, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('project_id', parsed.data.projectId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

export async function assignCategoryToSectionAction(
  input: z.input<typeof categoryAssignSchema>,
): Promise<ProjectCustomerViewResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = categoryAssignSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_budget_categories')
    .update({
      customer_section_id: parsed.data.sectionId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.categoryId)
    .select('project_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to assign category.' };
  }

  revalidatePath(`/projects/${data.project_id as string}`);
  return { ok: true };
}
