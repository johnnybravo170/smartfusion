'use server';

/**
 * Server actions for project budget category management.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type BudgetCategoryActionResult = { ok: true; id: string } | { ok: false; error: string };

export async function updateBudgetCategoryAction(input: {
  id: string;
  project_id: string;
  name?: string;
  estimate_cents?: number;
  description?: string;
  description_md?: string | null;
  is_visible_in_report?: boolean;
}): Promise<BudgetCategoryActionResult> {
  const supabase = await createClient();

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (!trimmed) return { ok: false, error: 'Name cannot be empty.' };
    updates.name = trimmed;
  }
  if (input.estimate_cents !== undefined) {
    // Single-source-of-truth guard: when the bucket has priced cost
    // lines, the lines sum drives the displayed estimate (see
    // project-budget-categories.ts query). Letting the operator edit
    // the envelope here would silently no-op in the UI — a confusing
    // dead control. Force them to edit lines instead.
    const { count: pricedCount } = await supabase
      .from('project_cost_lines')
      .select('id', { count: 'exact', head: true })
      .eq('budget_category_id', input.id)
      .gt('line_price_cents', 0);
    if ((pricedCount ?? 0) > 0) {
      return {
        ok: false,
        error:
          'This bucket has priced cost lines, so the estimate is the sum of those lines. Edit individual line prices to change it.',
      };
    }
    updates.estimate_cents = input.estimate_cents;
  }
  if (input.description !== undefined) updates.description = input.description || null;
  if (input.description_md !== undefined) {
    const trimmed = input.description_md?.trim();
    updates.description_md = trimmed ? trimmed : null;
  }
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
}): Promise<BudgetCategoryActionResult> {
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
    return { ok: false, error: error?.message ?? 'Failed to add category.' };
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

/**
 * Rename a section across all categories on a project. Sections are a
 * free-text label on `project_budget_categories.section` — there's no
 * sections table — so a rename is just an UPDATE that targets every
 * category in the project with the old section name.
 *
 * Idempotent on no-op (old === new) and on a section that doesn't
 * exist yet on this project.
 */
export async function renameSectionAction(input: {
  project_id: string;
  old_name: string;
  new_name: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const oldName = input.old_name.trim();
  const newName = input.new_name.trim();
  if (!oldName) return { ok: false, error: 'Missing existing section name.' };
  if (!newName) return { ok: false, error: 'Section name cannot be empty.' };
  if (newName.length > 80) return { ok: false, error: 'Section name too long.' };
  if (oldName === newName) return { ok: true };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_budget_categories')
    .update({ section: newName, updated_at: new Date().toISOString() })
    .eq('project_id', input.project_id)
    .eq('section', oldName);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true };
}

/**
 * Bulk reorder + cross-section move for categories on a project. The
 * client sends the new ordered list of (id, section) tuples — array
 * index becomes the new display_order, and any section change is
 * applied in the same UPDATE.
 *
 * Used by the drag-and-drop reorder UI. Sections that pre-existed but
 * are no longer in `ordered` (e.g. last category of a section was
 * dragged out) simply disappear, since sections are derived from
 * categories.
 */
export async function reorderBudgetCategoriesAction(input: {
  project_id: string;
  ordered: { id: string; section: string }[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient();

  // Re-number using the same `section_idx * 1000 + within` scheme that
  // moveSectionAction uses, so section order survives a category drag.
  const sectionsInOrder: string[] = [];
  for (const row of input.ordered) {
    const s = row.section.trim();
    if (!s) return { ok: false, error: 'Section cannot be empty.' };
    if (!sectionsInOrder.includes(s)) sectionsInOrder.push(s);
  }

  const withinCounters = new Map<string, number>();
  const updates: { id: string; section: string; display_order: number }[] = [];
  for (const row of input.ordered) {
    const s = row.section.trim();
    const sectionIdx = sectionsInOrder.indexOf(s);
    const within = withinCounters.get(s) ?? 0;
    withinCounters.set(s, within + 1);
    updates.push({
      id: row.id,
      section: s,
      display_order: sectionIdx * 1000 + within,
    });
  }

  const now = new Date().toISOString();
  for (const u of updates) {
    const { error } = await supabase
      .from('project_budget_categories')
      .update({ section: u.section, display_order: u.display_order, updated_at: now })
      .eq('id', u.id)
      .eq('project_id', input.project_id);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.project_id}`);
  return { ok: true };
}

export async function removeBudgetCategoryAction(input: {
  id: string;
  project_id: string;
}): Promise<BudgetCategoryActionResult> {
  const supabase = await createClient();

  // Check for linked time entries or expenses
  const { count: timeCount } = await supabase
    .from('time_entries')
    .select('id', { count: 'exact', head: true })
    .eq('budget_category_id', input.id);

  const { count: expenseCount } = await supabase
    .from('project_costs')
    .select('id', { count: 'exact', head: true })
    .eq('budget_category_id', input.id)
    .eq('status', 'active');

  if ((timeCount ?? 0) > 0 || (expenseCount ?? 0) > 0) {
    return {
      ok: false,
      error:
        'Cannot remove category with linked time entries or project costs. Reassign them first.',
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
 * Seed a project with default budget categories. Used when creating a project
 * from the AI or when manually resetting categories.
 */
export async function seedBudgetCategoriesFromTemplateAction(input: {
  project_id: string;
}): Promise<BudgetCategoryActionResult> {
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
