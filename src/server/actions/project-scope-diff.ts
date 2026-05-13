'use server';

/**
 * Server actions for the diff review screen — operator-facing actions
 * that act on a single change at a time.
 *
 * v1 scope: revert-only. Bundled "send as CO" lives on the existing
 * change-order create flow (operator clicks through to the Changes
 * tab). Auto-bundling from diff selections is a follow-up card.
 *
 * See decision 6790ef2b — diff-tracked + intentional-send.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getLatestSnapshot } from '@/lib/db/queries/project-scope-snapshots';
import { createAdminClient } from '@/lib/supabase/admin';

export type DiffActionResult = { ok: true } | { ok: false; error: string };

const revertChangeSchema = z.object({
  projectId: z.string().uuid(),
  changeKind: z.enum([
    'line_added',
    'line_removed',
    'line_modified',
    'category_added',
    'category_envelope_changed',
  ]),
  targetId: z.string().uuid(),
});

/**
 * Roll back a single change in the working state to the latest signed
 * snapshot value. Idempotent — re-running on an already-reverted
 * change is a no-op.
 */
export async function revertChangeAction(
  input: Record<string, unknown>,
): Promise<DiffActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = revertChangeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid revert request.' };

  const snapshot = await getLatestSnapshot(parsed.data.projectId);
  if (!snapshot) return { ok: false, error: 'No baseline to revert to.' };
  if (snapshot.tenant_id !== tenant.id) {
    return { ok: false, error: 'Project not in your tenant.' };
  }

  const admin = createAdminClient();
  const { changeKind, targetId, projectId } = parsed.data;

  if (changeKind === 'line_added') {
    // The line was added after the snapshot — delete it to revert.
    const { error } = await admin
      .from('project_cost_lines')
      .delete()
      .eq('id', targetId)
      .eq('project_id', projectId);
    if (error) return { ok: false, error: error.message };
  } else if (changeKind === 'line_removed') {
    // Line was in snapshot but is now gone — re-insert it.
    const snapLine = snapshot.cost_lines.find((l) => l.id === targetId);
    if (!snapLine) return { ok: false, error: 'Snapshot line not found.' };
    const { error } = await admin.from('project_cost_lines').insert({
      id: snapLine.id, // restore original id so future diffs match
      project_id: projectId,
      tenant_id: tenant.id,
      budget_category_id: snapLine.budget_category_id,
      category: snapLine.category,
      label: snapLine.label,
      qty: snapLine.qty,
      unit: snapLine.unit,
      unit_cost_cents: snapLine.unit_cost_cents,
      unit_price_cents: snapLine.unit_price_cents,
      line_cost_cents: snapLine.line_cost_cents,
      line_price_cents: snapLine.line_price_cents,
      sort_order: snapLine.sort_order,
    });
    if (error) return { ok: false, error: error.message };
  } else if (changeKind === 'line_modified') {
    // Reset the live row to snapshot values.
    const snapLine = snapshot.cost_lines.find((l) => l.id === targetId);
    if (!snapLine) return { ok: false, error: 'Snapshot line not found.' };
    const { error } = await admin
      .from('project_cost_lines')
      .update({
        budget_category_id: snapLine.budget_category_id,
        category: snapLine.category,
        label: snapLine.label,
        qty: snapLine.qty,
        unit: snapLine.unit,
        unit_cost_cents: snapLine.unit_cost_cents,
        unit_price_cents: snapLine.unit_price_cents,
        line_cost_cents: snapLine.line_cost_cents,
        line_price_cents: snapLine.line_price_cents,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetId)
      .eq('project_id', projectId);
    if (error) return { ok: false, error: error.message };
  } else if (changeKind === 'category_added') {
    // Bucket added after snapshot — delete it. Action layer rejects
    // deletes when linked entries exist; the diff will still show it
    // and the operator can resolve.
    const { count: timeCount } = await admin
      .from('time_entries')
      .select('id', { count: 'exact', head: true })
      .eq('budget_category_id', targetId);
    const { count: expenseCount } = await admin
      .from('project_costs')
      .select('id', { count: 'exact', head: true })
      .eq('budget_category_id', targetId)
      .eq('status', 'active');
    if ((timeCount ?? 0) > 0 || (expenseCount ?? 0) > 0) {
      return {
        ok: false,
        error:
          'Cannot revert: this category has time entries or project costs linked. Move them first.',
      };
    }
    const { error } = await admin
      .from('project_budget_categories')
      .delete()
      .eq('id', targetId)
      .eq('project_id', projectId);
    if (error) return { ok: false, error: error.message };
  } else if (changeKind === 'category_envelope_changed') {
    const snapCat = snapshot.budget_categories.find((c) => c.id === targetId);
    if (!snapCat) return { ok: false, error: 'Snapshot category not found.' };
    const { error } = await admin
      .from('project_budget_categories')
      .update({
        estimate_cents: snapCat.estimate_cents,
        updated_at: new Date().toISOString(),
      })
      .eq('id', targetId)
      .eq('project_id', projectId);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
