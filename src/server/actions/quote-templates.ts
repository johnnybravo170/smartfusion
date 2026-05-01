'use server';

/**
 * Operator-saved + Henry-suggested quote templates. Companion to the
 * built-in starter templates in src/data/starter-templates — those
 * ship as JSON in the codebase; user-saved templates live in
 * `quote_templates`.
 *
 * Both surfaces share the same StarterTemplate shape via the
 * `snapshot` JSONB column, so the apply flow is identical.
 *
 * See decision 6790ef2b — Henry as suggester, not commander. The
 * "save as template" button is operator-driven; Henry-suggested
 * templates are a separate trigger (kanban e1d81272) that always
 * routes through this same save flow with `source = 'henry_suggested'`.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { findStarterTemplate } from '@/data/starter-templates';
import type { StarterTemplate } from '@/data/starter-templates/types';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type SaveAsTemplateResult = { ok: true; id: string } | { ok: false; error: string };

const saveAsTemplateSchema = z.object({
  projectId: z.string().uuid(),
  label: z.string().trim().min(2, 'Name is too short').max(100, 'Name is too long'),
  description: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  visibility: z.enum(['private', 'tenant']),
  /** When false, ship the template with no prices (matches starter template
   * convention). When true, prices come along — operator chose to bake them
   * in (rare; useful for fixed-fee contractors). */
  includePrices: z.boolean(),
});

/**
 * Save a project's current scope as a re-usable template. Snapshots
 * the live `project_budget_categories` + `project_cost_lines` into
 * the `quote_templates.snapshot` JSONB.
 */
export async function saveProjectAsTemplateAction(
  input: Record<string, unknown>,
): Promise<SaveAsTemplateResult> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const parsed = saveAsTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { projectId, label, description, visibility, includePrices } = parsed.data;

  const admin = createAdminClient();

  // Pull the current scope.
  const [categoriesRes, linesRes] = await Promise.all([
    admin
      .from('project_budget_categories')
      .select('id, name, section, description, display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true }),
    admin
      .from('project_cost_lines')
      .select(
        'id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, sort_order',
      )
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true }),
  ]);
  if (categoriesRes.error) return { ok: false, error: categoriesRes.error.message };
  if (linesRes.error) return { ok: false, error: linesRes.error.message };

  type CategoryRow = {
    id: string;
    name: string;
    section: string;
    description: string | null;
    display_order: number;
  };
  type LineRow = {
    id: string;
    budget_category_id: string | null;
    category: string;
    label: string;
    qty: number;
    unit: string;
    unit_cost_cents: number;
    unit_price_cents: number;
    sort_order: number;
  };

  const categories = (categoriesRes.data ?? []) as CategoryRow[];
  const lines = (linesRes.data ?? []) as LineRow[];

  if (categories.length === 0 && lines.length === 0) {
    return { ok: false, error: 'Nothing to save — add some scope first.' };
  }

  // Build StarterTemplate-shaped snapshot.
  const linesByCategory = new Map<string, LineRow[]>();
  for (const l of lines) {
    if (!l.budget_category_id) continue;
    const arr = linesByCategory.get(l.budget_category_id) ?? [];
    arr.push(l);
    linesByCategory.set(l.budget_category_id, arr);
  }

  const snapshot: StarterTemplate = {
    slug: '', // not used for user templates; kept for type compatibility
    label,
    description: description ?? '',
    categories: categories.map((b) => ({
      name: b.name,
      section: b.section,
      description: b.description ?? undefined,
      lines: (linesByCategory.get(b.id) ?? []).map((l) => ({
        label: l.label,
        category: l.category as 'material' | 'labour' | 'sub' | 'equipment' | 'overhead',
        qty: l.qty,
        unit: l.unit,
        // Per-row "include prices" toggle: when off, store unit_price_cents=0
        // so the apply flow doesn't carry stale prices. Same approach as
        // starter templates.
        ...(includePrices
          ? {
              unit_cost_cents: l.unit_cost_cents,
              unit_price_cents: l.unit_price_cents,
            }
          : {}),
      })),
    })),
  };

  const { data, error } = await admin
    .from('quote_templates')
    .insert({
      tenant_id: tenant.id,
      label,
      description,
      visibility,
      snapshot,
      source: 'save_as',
      source_project_id: projectId,
      created_by: user.id,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Could not save template.' };
  }

  revalidatePath(`/projects/${projectId}`);
  revalidatePath('/settings/templates');
  return { ok: true, id: data.id };
}

export type CombinedTemplateListItem = {
  source: 'starter' | 'user';
  slug: string; // for starter; user templates use their UUID
  label: string;
  description: string;
  categoryCount: number;
  lineCount: number;
  visibility?: 'private' | 'tenant';
};

/**
 * Read a stored snapshot's categories array. Backcompat: pre-rename rows
 * used the `buckets` key — fall back to that when the new key is absent.
 */
function snapshotCategories(
  snapshot: StarterTemplate | null | undefined,
): StarterTemplate['categories'] {
  if (!snapshot) return [];
  const newShape = snapshot.categories;
  if (Array.isArray(newShape)) return newShape;
  // backcompat: pre-rename rows used `buckets` key
  const legacy = (snapshot as unknown as { buckets?: StarterTemplate['categories'] }).buckets;
  return Array.isArray(legacy) ? legacy : [];
}

/** Combined picker list: built-in starter templates + user-saved templates. */
export async function listAllTemplatesAction(): Promise<CombinedTemplateListItem[]> {
  const tenant = await getCurrentTenant();
  const out: CombinedTemplateListItem[] = [];

  // Starter templates (always available).
  const { STARTER_TEMPLATES } = await import('@/data/starter-templates');
  for (const t of STARTER_TEMPLATES) {
    out.push({
      source: 'starter',
      slug: t.slug,
      label: t.label,
      description: t.description,
      categoryCount: t.categories.length,
      lineCount: t.categories.reduce((s, b) => s + b.lines.length, 0),
    });
  }

  // User-saved templates from this tenant (RLS handles private vs tenant
  // visibility automatically).
  if (tenant) {
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    const { data } = await supabase
      .from('quote_templates')
      .select('id, label, description, snapshot, visibility')
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    for (const row of (data ?? []) as Array<{
      id: string;
      label: string;
      description: string | null;
      snapshot: StarterTemplate;
      visibility: 'private' | 'tenant';
    }>) {
      const categories = snapshotCategories(row.snapshot);
      out.push({
        source: 'user',
        slug: row.id,
        label: row.label,
        description: row.description ?? '',
        categoryCount: categories.length,
        lineCount: categories.reduce((s, b) => s + b.lines.length, 0),
        visibility: row.visibility,
      });
    }
  }

  return out;
}

/**
 * Apply a template (starter or user-saved) to an empty project.
 * Branches on source — starter templates come from JSON, user
 * templates from the quote_templates row. Same insert behaviour
 * either way.
 */
export async function applyTemplateAction(input: {
  projectId: string;
  source: 'starter' | 'user';
  slug: string;
}): Promise<{ ok: true; categoryCount: number; lineCount: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();

  // Verify project ownership.
  const { data: project } = await admin
    .from('projects')
    .select('id, tenant_id')
    .eq('id', input.projectId)
    .maybeSingle();
  if (!project || project.tenant_id !== tenant.id) {
    return { ok: false, error: 'Project not found.' };
  }

  // Refuse merge into existing scope.
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
      error: 'Project already has categories or line items. Clear them first.',
    };
  }

  // Resolve the template body.
  let template: StarterTemplate | null = null;
  if (input.source === 'starter') {
    template = findStarterTemplate(input.slug);
  } else {
    const { data: row } = await admin
      .from('quote_templates')
      .select('snapshot')
      .eq('id', input.slug)
      .eq('tenant_id', tenant.id)
      .is('deleted_at', null)
      .maybeSingle();
    template = (row?.snapshot as StarterTemplate | null) ?? null;
  }
  if (!template) return { ok: false, error: 'Template not found.' };

  // Insert categories + lines. Snapshot may use legacy `buckets` key.
  const templateCategories = snapshotCategories(template);
  const categoryRows = templateCategories.map((b, i) => ({
    project_id: input.projectId,
    tenant_id: tenant.id,
    name: b.name,
    section: b.section,
    description: b.description ?? null,
    estimate_cents: 0,
    display_order: i,
  }));
  const { data: insertedCategories, error: categoryErr } = await admin
    .from('project_budget_categories')
    .insert(categoryRows)
    .select('id, name');
  if (categoryErr) return { ok: false, error: categoryErr.message };

  const categoryIdByName = new Map<string, string>();
  for (const b of insertedCategories ?? []) {
    categoryIdByName.set(b.name as string, b.id as string);
  }

  type LineToInsert = {
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
  };
  const lineRows: LineToInsert[] = [];
  let sortOrder = 0;
  for (const category of templateCategories) {
    const categoryId = categoryIdByName.get(category.name);
    if (!categoryId) continue;
    for (const line of category.lines) {
      const unit_cost_cents = (line as { unit_cost_cents?: number }).unit_cost_cents ?? 0;
      const unit_price_cents = (line as { unit_price_cents?: number }).unit_price_cents ?? 0;
      lineRows.push({
        project_id: input.projectId,
        tenant_id: tenant.id,
        budget_category_id: categoryId,
        category: line.category,
        label: line.label,
        qty: line.qty,
        unit: line.unit,
        unit_cost_cents,
        unit_price_cents,
        line_cost_cents: Math.round(line.qty * unit_cost_cents),
        line_price_cents: Math.round(line.qty * unit_price_cents),
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
