/**
 * Server-side reads for the per-project team checklist. All queries run
 * under RLS via `createClient()` — every authenticated tenant member can
 * read their tenant's items; cross-tenant rows are filtered by RLS.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { CHECKLIST_HIDE_HOURS_DEFAULT } from '@/lib/validators/project-checklist';

export type ChecklistItemRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  title: string;
  category: string | null;
  photo_storage_path: string | null;
  photo_mime: string | null;
  created_by: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
};

const SELECT_COLS =
  'id, tenant_id, project_id, title, category, photo_storage_path, photo_mime, created_by, completed_at, completed_by, created_at, updated_at';

/**
 * Read the per-tenant "hide completed items after N hours" preference.
 * Returns `null` for "never hide", or a number of hours otherwise. Default
 * 48h on first read.
 */
export async function getChecklistHideHours(tenantId: string): Promise<number | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenant_prefs')
    .select('data')
    .eq('tenant_id', tenantId)
    .eq('namespace', 'checklist')
    .maybeSingle();

  const prefs = (data?.data ?? null) as { hide_completed_after_hours?: number | null } | null;
  if (!prefs) return CHECKLIST_HIDE_HOURS_DEFAULT;
  // Explicit null means "never hide".
  if (prefs.hide_completed_after_hours === null) return null;
  if (typeof prefs.hide_completed_after_hours !== 'number') return CHECKLIST_HIDE_HOURS_DEFAULT;
  return prefs.hide_completed_after_hours;
}

/**
 * List checklist items for a single project. Open items first (newest at
 * the top), then recently-completed items within the tenant's hide window.
 *
 * Older completed items are excluded — they're still in the table for
 * audit, but the worker's UI shouldn't be cluttered with last week's
 * crossed-off lines.
 */
export async function listChecklistForProject(
  projectId: string,
  hideHours: number | null,
): Promise<ChecklistItemRow[]> {
  const supabase = await createClient();

  let query = supabase
    .from('project_checklist_items')
    .select(SELECT_COLS)
    .eq('project_id', projectId);

  if (hideHours !== null) {
    const cutoffMs = Date.now() - hideHours * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();
    // Open items always show; completed items only if completed within window.
    query = query.or(`completed_at.is.null,completed_at.gte.${cutoffIso}`);
  }

  const { data } = await query
    .order('completed_at', { ascending: true, nullsFirst: true })
    .order('created_at', { ascending: false });

  return (data ?? []) as ChecklistItemRow[];
}

/**
 * Distinct categories used previously on this project — used to populate
 * the category combobox suggestions when adding a new item.
 */
export async function listCategoriesForProject(projectId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('project_checklist_items')
    .select('category')
    .eq('project_id', projectId)
    .not('category', 'is', null);

  const seen = new Set<string>();
  for (const row of (data ?? []) as { category: string | null }[]) {
    if (row.category) seen.add(row.category);
  }
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
}

export type ProjectChecklistRollupRow = {
  project_id: string;
  project_name: string;
  customer_name: string | null;
  open_count: number;
};

/**
 * Tenant-wide rollup: every project with at least one open checklist item.
 * Drives the GC dashboard chip ("Team checklist: 6 open across 3 jobs")
 * and the dedicated /checklists page.
 */
export async function listOpenChecklistRollup(
  tenantId: string,
): Promise<ProjectChecklistRollupRow[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('project_checklist_items')
    .select('project_id, projects:project_id (name, customers:customer_id (name))')
    .eq('tenant_id', tenantId)
    .is('completed_at', null);

  type Row = {
    project_id: string;
    projects:
      | { name?: string; customers?: { name?: string } | { name?: string }[] | null }
      | { name?: string; customers?: { name?: string } | { name?: string }[] | null }[]
      | null;
  };

  const counts = new Map<string, ProjectChecklistRollupRow>();
  for (const r of (data ?? []) as Row[]) {
    const proj = Array.isArray(r.projects) ? r.projects[0] : r.projects;
    const cust = proj && (Array.isArray(proj.customers) ? proj.customers[0] : proj.customers);
    const existing = counts.get(r.project_id);
    if (existing) {
      existing.open_count += 1;
    } else {
      counts.set(r.project_id, {
        project_id: r.project_id,
        project_name: proj?.name ?? 'Project',
        customer_name: cust?.name ?? null,
        open_count: 1,
      });
    }
  }

  return Array.from(counts.values()).sort((a, b) => b.open_count - a.open_count);
}

/**
 * The most recent project a worker logged time against. Used as the
 * worker dashboard's default "current site" so they don't have to pick
 * every time they open the app.
 *
 * Returns `null` if the worker has no time entries with a project (e.g.
 * brand-new worker, or all entries were against jobs).
 */
export async function getLastBilledProjectForWorker(userId: string): Promise<{
  project_id: string;
  project_name: string;
} | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from('time_entries')
    .select('project_id, projects:project_id (name)')
    .eq('user_id', userId)
    .not('project_id', 'is', null)
    .order('entry_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.project_id) return null;

  const proj = Array.isArray((data as { projects?: unknown }).projects)
    ? ((data as { projects: { name?: string }[] }).projects[0] ?? null)
    : ((data as { projects?: { name?: string } | null }).projects ?? null);

  return {
    project_id: data.project_id as string,
    project_name: proj?.name ?? 'Project',
  };
}
