'use server';

/**
 * Apply a built-in starter template to a project — seeds budget
 * categories + cost lines from a hand-authored JSON in
 * src/data/starter-templates.
 *
 * Per the rollup, templates ship with no prices: structure only. The
 * operator fills in qty / cost / price per project. This avoids the
 * stale-pricing trap that JobTread-style auto-fill templates fall
 * into.
 *
 * Refuses to apply when the project already has cost lines or
 * non-empty budget categories — operators can clear the project first
 * or use the per-category "+ Add line" flow to layer manually.
 */

import { revalidatePath } from 'next/cache';
import { findStarterTemplate, STARTER_TEMPLATES } from '@/data/starter-templates';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type ApplyTemplateResult =
  | { ok: true; categoryCount: number; lineCount: number }
  | { ok: false; error: string };

export async function applyStarterTemplateAction(input: {
  projectId: string;
  templateSlug: string;
}): Promise<ApplyTemplateResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const template = findStarterTemplate(input.templateSlug);
  if (!template) return { ok: false, error: 'Template not found.' };

  const admin = createAdminClient();

  // Confirm the project belongs to this tenant.
  const { data: project } = await admin
    .from('projects')
    .select('id, tenant_id')
    .eq('id', input.projectId)
    .maybeSingle();
  if (!project || project.tenant_id !== tenant.id) {
    return { ok: false, error: 'Project not found.' };
  }

  // Refuse if there's already meaningful scope authored — we don't
  // want to silently merge into an existing budget.
  const [{ count: lineCount }, { count: categoryCount }] = await Promise.all([
    admin
      .from('project_cost_lines')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', input.projectId),
    admin
      .from('project_budget_categories')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', input.projectId),
  ]);
  if ((lineCount ?? 0) > 0 || (categoryCount ?? 0) > 0) {
    return {
      ok: false,
      error:
        'Project already has budget categories or line items. Clear them first, or use "+ Add line" to layer manually.',
    };
  }

  // Insert categories first; build a name → id map so lines can
  // reference their parent category by id.
  const categoryRows = template.categories.map((c, i) => ({
    project_id: input.projectId,
    tenant_id: tenant.id,
    name: c.name,
    section: c.section,
    description: c.description ?? null,
    estimate_cents: 0,
    display_order: i,
  }));
  const { data: insertedCategories, error: categoryErr } = await admin
    .from('project_budget_categories')
    .insert(categoryRows)
    .select('id, name');
  if (categoryErr) return { ok: false, error: categoryErr.message };

  const categoryIdByName = new Map<string, string>();
  for (const c of insertedCategories ?? []) {
    categoryIdByName.set(c.name as string, c.id as string);
  }

  // Insert cost lines, no prices set — operator fills in.
  const lineRows: Array<{
    project_id: string;
    tenant_id: string;
    budget_category_id: string;
    category: string;
    label: string;
    qty: number;
    unit: string;
    unit_cost_cents: number;
    unit_price_cents: number;
    line_cost_cents: number;
    line_price_cents: number;
    sort_order: number;
  }> = [];
  let sortOrder = 0;
  for (const category of template.categories) {
    const categoryId = categoryIdByName.get(category.name);
    if (!categoryId) continue;
    for (const line of category.lines) {
      lineRows.push({
        project_id: input.projectId,
        tenant_id: tenant.id,
        budget_category_id: categoryId,
        category: line.category,
        label: line.label,
        qty: line.qty,
        unit: line.unit,
        unit_cost_cents: 0,
        unit_price_cents: 0,
        line_cost_cents: 0,
        line_price_cents: 0,
        sort_order: sortOrder++,
      });
    }
  }

  if (lineRows.length > 0) {
    const { error: linesErr } = await admin.from('project_cost_lines').insert(lineRows);
    if (linesErr) return { ok: false, error: linesErr.message };
  }

  revalidatePath(`/projects/${input.projectId}`);
  return {
    ok: true,
    categoryCount: insertedCategories?.length ?? 0,
    lineCount: lineRows.length,
  };
}

/** Public list of starter templates for the picker UI. */
export async function listStarterTemplatesAction(): Promise<
  Array<{
    slug: string;
    label: string;
    description: string;
    categoryCount: number;
    lineCount: number;
  }>
> {
  return STARTER_TEMPLATES.map((t) => ({
    slug: t.slug,
    label: t.label,
    description: t.description,
    categoryCount: t.categories.length,
    lineCount: t.categories.reduce((s, c) => s + c.lines.length, 0),
  }));
}
