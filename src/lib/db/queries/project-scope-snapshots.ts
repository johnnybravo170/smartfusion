/**
 * Helpers for `project_scope_snapshots` — the immutable per-version
 * record of a project's scope captured at each customer-signed event.
 *
 * The snapshot is the baseline for the diff-tracked + intentional-send
 * post-approval edit flow (decision 6790ef2b). It is written from
 * server actions at exactly two events: estimate approval and CO apply.
 *
 * Reads happen from the diff-tracking primitive (chip count) and the
 * Versions dropdown UI; both run under RLS, the writes use the admin
 * client because they fire from system code paths and need to bypass
 * the no-update / no-delete RLS posture on the table.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/** Frozen line-item shape kept inside the snapshot's `cost_lines` JSONB. */
export type SnapshotCostLine = {
  id: string;
  budget_category_id: string | null;
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

/** Frozen budget-category shape kept inside the snapshot's `budget_categories` JSONB. */
export type SnapshotBudgetCategory = {
  id: string;
  name: string;
  section: string;
  estimate_cents: number;
  display_order: number;
};

export type ProjectScopeSnapshot = {
  id: string;
  project_id: string;
  tenant_id: string;
  version_number: number;
  label: string | null;
  change_order_id: string | null;
  cost_lines: SnapshotCostLine[];
  budget_categories: SnapshotBudgetCategory[];
  total_cents: number;
  signed_at: string;
  signed_by_name: string | null;
  created_at: string;
};

/**
 * Capture the current scope of a project as an immutable snapshot.
 * Called from server actions on the two customer-signed events:
 *
 *   - estimate approval: `label="Original estimate"`, no changeOrderId
 *   - CO apply:          `label="CO #N — <co.title>"`, changeOrderId set
 *
 * Idempotent on (project_id, version_number) via the unique constraint —
 * if called twice for the same version the second insert silently no-ops
 * via ON CONFLICT.
 */
export async function snapshotProjectScope(input: {
  projectId: string;
  tenantId: string;
  label: string;
  signedAt: string;
  signedByName?: string | null;
  changeOrderId?: string | null;
}): Promise<{ ok: true; versionNumber: number } | { ok: false; error: string }> {
  const admin = createAdminClient();

  // 1. Pull the current scope (cost_lines + budget_categories + total).
  const [linesRes, bucketsRes] = await Promise.all([
    admin
      .from('project_cost_lines')
      .select(
        'id, budget_category_id, category, label, qty, unit, unit_cost_cents, unit_price_cents, line_cost_cents, line_price_cents, sort_order',
      )
      .eq('project_id', input.projectId)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true }),
    admin
      .from('project_budget_categories')
      .select('id, name, section, estimate_cents, display_order')
      .eq('project_id', input.projectId)
      .order('display_order', { ascending: true }),
  ]);

  if (linesRes.error) return { ok: false, error: linesRes.error.message };
  if (bucketsRes.error) return { ok: false, error: bucketsRes.error.message };

  const costLines = (linesRes.data ?? []) as SnapshotCostLine[];
  const budgetCategories = (bucketsRes.data ?? []) as SnapshotBudgetCategory[];
  const totalCents = costLines.reduce((s, l) => s + (l.line_price_cents ?? 0), 0);

  // 2. Pick the next version number — monotonic per project.
  const { data: highest } = await admin
    .from('project_scope_snapshots')
    .select('version_number')
    .eq('project_id', input.projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = ((highest?.version_number as number | undefined) ?? 0) + 1;

  // 3. Insert. The unique (project_id, version_number) constraint guards
  // against double-firing under race conditions; we surface the conflict
  // as a soft success (version already captured).
  const { error: insertErr } = await admin.from('project_scope_snapshots').insert({
    project_id: input.projectId,
    tenant_id: input.tenantId,
    version_number: nextVersion,
    label: input.label,
    change_order_id: input.changeOrderId ?? null,
    cost_lines: costLines,
    budget_categories: budgetCategories,
    total_cents: totalCents,
    signed_at: input.signedAt,
    signed_by_name: input.signedByName ?? null,
  });

  if (insertErr) {
    // Race condition: another concurrent caller already wrote this version.
    if (insertErr.code === '23505') {
      return { ok: true, versionNumber: nextVersion };
    }
    return { ok: false, error: insertErr.message };
  }

  return { ok: true, versionNumber: nextVersion };
}

/**
 * The most recent (highest version number) snapshot for a project, or
 * null if no snapshot exists. Used by the diff-compute query to decide
 * what to compare working state against.
 */
export async function getLatestSnapshot(projectId: string): Promise<ProjectScopeSnapshot | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('project_scope_snapshots')
    .select('*')
    .eq('project_id', projectId)
    .order('version_number', { ascending: false })
    .limit(1)
    .maybeSingle();

  return (data as ProjectScopeSnapshot) ?? null;
}

/** All snapshots for a project, oldest first. Drives the Versions dropdown. */
export async function listSnapshots(projectId: string): Promise<ProjectScopeSnapshot[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('project_scope_snapshots')
    .select('*')
    .eq('project_id', projectId)
    .order('version_number', { ascending: true });

  return ((data ?? []) as ProjectScopeSnapshot[]) ?? [];
}
