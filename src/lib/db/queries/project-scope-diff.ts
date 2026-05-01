/**
 * Compute the unsigned-changes diff between a project's working state
 * (live `project_cost_lines` + `project_budget_categories`) and the
 * latest scope snapshot (last customer-signed version).
 *
 * Drives the unsent-changes chip + the per-change triage screen
 * (separate card). Henry's suggested categorization for each change is
 * computed alongside, but operators always override at triage time.
 *
 * See decision 6790ef2b — diff-tracked + intentional-send.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  getLatestSnapshot,
  type SnapshotBudgetCategory,
  type SnapshotCostLine,
} from './project-scope-snapshots';

export type DiffChange =
  | {
      kind: 'line_added';
      line: SnapshotCostLine;
      henry_suggests: 'send_as_co';
    }
  | {
      kind: 'line_removed';
      line: SnapshotCostLine; // the snapshotted (signed) line that's now gone
      henry_suggests: 'send_as_co';
    }
  | {
      kind: 'line_modified';
      before: SnapshotCostLine;
      after: SnapshotCostLine;
      changed_fields: Array<
        'qty' | 'unit_price_cents' | 'unit_cost_cents' | 'label' | 'budget_category_id'
      >;
      henry_suggests: 'send_as_co' | 'internal';
    }
  | {
      kind: 'category_added';
      category: SnapshotBudgetCategory;
      henry_suggests: 'internal';
    }
  | {
      kind: 'category_envelope_changed';
      before: SnapshotBudgetCategory;
      after: SnapshotBudgetCategory;
      henry_suggests: 'send_as_co' | 'internal';
    };

export type ProjectScopeDiff = {
  has_baseline: boolean;
  baseline_version: number | null;
  baseline_total_cents: number;
  current_total_cents: number;
  total_delta_cents: number;
  changes: DiffChange[];
  /** Quick summary: count of changes Henry would suggest as customer-impacting. */
  suggested_co_count: number;
  /** Total change count (any kind) — drives the chip badge. */
  total_change_count: number;
};

const EMPTY_DIFF: ProjectScopeDiff = {
  has_baseline: false,
  baseline_version: null,
  baseline_total_cents: 0,
  current_total_cents: 0,
  total_delta_cents: 0,
  changes: [],
  suggested_co_count: 0,
  total_change_count: 0,
};

/**
 * Compute the diff for a project. Returns an empty diff when no
 * snapshot exists (legacy / pre-snapshot project) so the chip stays
 * hidden — we don't want to surface false alarms on projects that were
 * already approved before the snapshot table existed.
 */
export async function getUnsentDiff(projectId: string): Promise<ProjectScopeDiff> {
  const snapshot = await getLatestSnapshot(projectId);
  if (!snapshot) return EMPTY_DIFF;

  const admin = createAdminClient();
  const [linesRes, categoriesRes] = await Promise.all([
    admin
      .from('project_cost_lines')
      .select(
        'id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, sort_order',
      )
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true }),
    admin
      .from('project_budget_categories')
      .select('id, name, section, estimate_cents, display_order')
      .eq('project_id', projectId)
      .order('display_order', { ascending: true }),
  ]);

  const currentLines = (linesRes.data ?? []) as SnapshotCostLine[];
  const currentCategories = (categoriesRes.data ?? []) as SnapshotBudgetCategory[];
  const currentTotalCents = currentLines.reduce((s, l) => s + (l.line_price_cents ?? 0), 0);

  const snapLinesById = new Map<string, SnapshotCostLine>();
  for (const l of snapshot.cost_lines) snapLinesById.set(l.id, l);
  const snapCategoriesById = new Map<string, SnapshotBudgetCategory>();
  for (const c of snapshot.budget_categories) snapCategoriesById.set(c.id, c);

  const currentLinesById = new Map<string, SnapshotCostLine>();
  for (const l of currentLines) currentLinesById.set(l.id, l);
  const currentCategoriesById = new Map<string, SnapshotBudgetCategory>();
  for (const c of currentCategories) currentCategoriesById.set(c.id, c);

  const changes: DiffChange[] = [];

  // 1. Line-level diff
  for (const line of currentLines) {
    const before = snapLinesById.get(line.id);
    if (!before) {
      changes.push({ kind: 'line_added', line, henry_suggests: 'send_as_co' });
      continue;
    }
    const cf: Array<
      'qty' | 'unit_price_cents' | 'unit_cost_cents' | 'label' | 'budget_category_id'
    > = [];
    if (Number(line.qty) !== Number(before.qty)) cf.push('qty');
    if (line.unit_price_cents !== before.unit_price_cents) cf.push('unit_price_cents');
    if (line.unit_cost_cents !== before.unit_cost_cents) cf.push('unit_cost_cents');
    if ((line.label ?? '') !== (before.label ?? '')) cf.push('label');
    if ((line.budget_category_id ?? null) !== (before.budget_category_id ?? null))
      cf.push('budget_category_id');

    if (cf.length === 0) continue;

    // Henry suggestion logic:
    //   - Label change on a customer-visible line → send_as_co (scope changed)
    //   - Pure category move with no label/total change → internal
    //   - Total or qty change with same label → send_as_co (it's customer-facing dollars)
    const labelChanged = cf.includes('label');
    const totalChanged = line.line_price_cents !== before.line_price_cents;
    const onlyCategoryMoved = cf.length === 1 && cf[0] === 'budget_category_id';

    let suggests: 'send_as_co' | 'internal' = 'send_as_co';
    if (onlyCategoryMoved) suggests = 'internal';
    if (!labelChanged && !totalChanged) suggests = 'internal';

    changes.push({
      kind: 'line_modified',
      before,
      after: line,
      changed_fields: cf,
      henry_suggests: suggests,
    });
  }

  for (const before of snapshot.cost_lines) {
    if (!currentLinesById.has(before.id)) {
      changes.push({ kind: 'line_removed', line: before, henry_suggests: 'send_as_co' });
    }
  }

  // 2. Category-level diff (envelope edits + new categories)
  for (const cat of currentCategories) {
    const before = snapCategoriesById.get(cat.id);
    if (!before) {
      changes.push({ kind: 'category_added', category: cat, henry_suggests: 'internal' });
      continue;
    }
    if (before.estimate_cents !== cat.estimate_cents) {
      // Envelope amount changed. If lines for this category also
      // changed, the line-level diff already represents the dollar
      // change — flag this as internal to avoid double-counting.
      const linesInCatChanged = currentLines.some(
        (l) =>
          l.budget_category_id === cat.id &&
          (() => {
            const sl = snapLinesById.get(l.id);
            return !sl || sl.line_price_cents !== l.line_price_cents;
          })(),
      );
      changes.push({
        kind: 'category_envelope_changed',
        before,
        after: cat,
        henry_suggests: linesInCatChanged ? 'internal' : 'send_as_co',
      });
    }
  }

  // (We don't surface category_removed — category deletes are blocked at
  // the action layer when they have linked entries; orphan removals
  // are vanishingly rare and not customer-facing.)

  const suggestedCoCount = changes.filter((c) => c.henry_suggests === 'send_as_co').length;

  return {
    has_baseline: true,
    baseline_version: snapshot.version_number,
    baseline_total_cents: snapshot.total_cents,
    current_total_cents: currentTotalCents,
    total_delta_cents: currentTotalCents - snapshot.total_cents,
    changes,
    suggested_co_count: suggestedCoCount,
    total_change_count: changes.length,
  };
}
