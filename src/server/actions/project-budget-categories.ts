'use server';

/**
 * Server actions for project cost bucket management.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type BucketActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function updateBudgetCategoryAction(input: {
  id: string;
  project_id: string;
  estimate_cents?: number;
  description?: string;
  is_visible_in_report?: boolean;
}): Promise<BucketActionResult> {
  const supabase = await createClient();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.estimate_cents !== undefined) updates.estimate_cents = input.estimate_cents;
  if (input.description !== undefined) updates.description = input.description || null;
  if (input.is_visible_in_report !== undefined)
    updates.is_visible_in_report = input.is_visible_in_report;

  const { error } = await supabase
    .from('project_budget_categories')
    .update(updates)
    .eq('id', input.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, id: input.id };
}

export async function addBudgetCategoryAction(input: {
  project_id: string;
  name: string;
  section: string;
  description?: string;
  estimate_cents?: number;
}): Promise<BucketActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Determine next display_order
  const { data: existing } = await supabase
    .from('project_budget_categories')
    .select('display_order')
    .eq('project_id', input.project_id)
    .order('display_order', { ascending: false })
    .limit(1);

  const nextOrder = existing?.[0]
    ? (existing[0] as { display_order: number }).display_order + 1
    : 0;

  const { data, error } = await supabase
    .from('project_budget_categories')
    .insert({
      project_id: input.project_id,
      tenant_id: tenant.id,
      name: input.name,
      section: input.section,
      description: input.description || null,
      estimate_cents: input.estimate_cents ?? 0,
      display_order: nextOrder,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to add bucket.' };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, id: data.id };
}

/**
 * Move a section up or down in the budget table by swapping it with its
 * adjacent section. Implemented by recomputing display_order across every
 * category in the project as `section_index * 1000 + within_section_index`.
 *
 * Within-section order is preserved by sorting the existing rows on
 * (display_order ASC, name ASC) before reassignment — same secondary sort
 * the read query uses, so the visible order on screen is what gets
 * captured.
 *
 * No-ops gracefully when the section is already at the edge or doesn't
 * exist on this project.
 */
export async function moveSectionAction(input: {
  project_id: string;
  section: string;
  direction: 'up' | 'down';
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();

  const { data: rows, error } = await supabase
    .from('project_budget_categories')
    .select('id, name, section, display_order')
    .eq('project_id', input.project_id)
    .order('display_order', { ascending: true })
    .order('name', { ascending: true });

  if (error) return { ok: false, error: error.message };

  const sectionsInOrder: string[] = [];
  for (const r of rows ?? []) {
    const s = (r as { section: string }).section;
    if (!sectionsInOrder.includes(s)) sectionsInOrder.push(s);
  }

  const idx = sectionsInOrder.indexOf(input.section);
  if (idx === -1) return { ok: false, error: 'Section not found.' };

  const swapWith = input.direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= sectionsInOrder.length) {
    return { ok: true }; // already at the edge — no-op
  }

  const reordered = [...sectionsInOrder];
  [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];

  const updates: { id: string; display_order: number }[] = [];
  reordered.forEach((sec, sectionIdx) => {
    const inSection = (rows ?? []).filter((r) => (r as { section: string }).section === sec);
    inSection.forEach((r, withinIdx) => {
      updates.push({
        id: (r as { id: string }).id,
        display_order: sectionIdx * 1000 + withinIdx,
      });
    });
  });

  // No bulk-update primitive in PostgREST; fan out one-by-one. Project
  // budget tables are small (~10s of rows), so this is cheap.
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('project_budget_categories')
      .update({ display_order: u.display_order, updated_at: new Date().toISOString() })
      .eq('id', u.id);
    if (upErr) return { ok: false, error: upErr.message };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true };
}

export async function removeBudgetCategoryAction(input: {
  id: string;
  project_id: string;
}): Promise<BucketActionResult> {
  const supabase = await createClient();

  // Check for linked time entries or expenses
  const { count: timeCount } = await supabase
    .from('time_entries')
    .select('id', { count: 'exact', head: true })
    .eq('budget_category_id', input.id);

  const { count: expenseCount } = await supabase
    .from('expenses')
    .select('id', { count: 'exact', head: true })
    .eq('budget_category_id', input.id);

  if ((timeCount ?? 0) > 0 || (expenseCount ?? 0) > 0) {
    return {
      ok: false,
      error: 'Cannot remove bucket with linked time entries or expenses. Reassign them first.',
    };
  }

  const { error } = await supabase.from('project_budget_categories').delete().eq('id', input.id);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, id: input.id };
}

/**
 * Seed a project with default cost buckets. Used when creating a project
 * from the AI or when manually resetting buckets.
 */
export async function seedBucketsFromTemplateAction(input: {
  project_id: string;
}): Promise<BucketActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const INTERIOR = [
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
  const EXTERIOR = [
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

  const supabase = await createClient();

  const rows = [
    ...INTERIOR.map((name, i) => ({
      project_id: input.project_id,
      tenant_id: tenant.id,
      name,
      section: 'interior' as const,
      display_order: i,
    })),
    ...EXTERIOR.map((name, i) => ({
      project_id: input.project_id,
      tenant_id: tenant.id,
      name,
      section: 'exterior' as const,
      display_order: INTERIOR.length + i,
    })),
  ];

  const { error } = await supabase.from('project_budget_categories').insert(rows);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true, id: input.project_id };
}
