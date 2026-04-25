/**
 * "🎉 Customer just opened/approved your estimate" celebration — returns
 * the most recent unacknowledged event for the current operator's tenant,
 * or null when there's nothing to celebrate.
 *
 * Each project can fire this once per kind. `project_events.acknowledged_at`
 * is backfilled for historical rows (see migration 0092), so on deploy the
 * card won't surface anything that happened before the feature existed.
 *
 * If a project has BOTH an unacknowledged `estimate_viewed` AND an
 * unacknowledged `estimate_approved`, the approval wins — it's the bigger
 * news, and we don't want to surface two cards for the same project.
 */

import { createClient } from '@/lib/supabase/server';

export type EstimateCelebration = {
  eventId: string;
  projectId: string;
  projectName: string;
  customerName: string | null;
  viewedAt: string;
  kind: 'viewed' | 'approved';
};

export async function getPendingEstimateCelebration(): Promise<EstimateCelebration | null> {
  const supabase = await createClient();

  // Pull all unacknowledged celebration events for the tenant, newest
  // first. Then collapse per project (preferring approved over viewed).
  const { data: events, error } = await supabase
    .from('project_events')
    .select('id, project_id, occurred_at, kind')
    .in('kind', ['estimate_viewed', 'estimate_approved'])
    .is('acknowledged_at', null)
    .order('occurred_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`Celebration: ${error.message}`);
  if (!events?.length) return null;

  // Per project: prefer the approved event if one exists; otherwise the
  // earliest viewed event (matches old behavior — re-visits don't
  // re-celebrate, only the very first view does).
  type Row = {
    id: string;
    project_id: string;
    occurred_at: string;
    kind: 'estimate_viewed' | 'estimate_approved';
  };
  const rows = events as unknown as Row[];

  const projectIds = Array.from(new Set(rows.map((e) => e.project_id)));

  // For viewed events, we need to confirm this is still the *first* view
  // (i.e. not a re-visit on a project whose first view was already
  // acknowledged). Pull all viewed rows for these projects.
  const { data: allViewed } = await supabase
    .from('project_events')
    .select('project_id, occurred_at, acknowledged_at, id')
    .eq('kind', 'estimate_viewed')
    .in('project_id', projectIds)
    .order('occurred_at', { ascending: true });

  const firstViewByProject = new Map<string, { id: string; occurred_at: string; acked: boolean }>();
  for (const row of allViewed ?? []) {
    const pid = row.project_id as string;
    if (!firstViewByProject.has(pid)) {
      firstViewByProject.set(pid, {
        id: row.id as string,
        occurred_at: row.occurred_at as string,
        acked: row.acknowledged_at !== null,
      });
    }
  }

  // Group unacknowledged candidates by project, preferring approved.
  type Candidate = { id: string; occurred_at: string; kind: 'viewed' | 'approved' };
  const candidateByProject = new Map<string, Candidate>();
  for (const row of rows) {
    if (row.kind === 'estimate_approved') {
      // Approved always wins. If we already saw a viewed candidate for
      // this project, replace it.
      const existing = candidateByProject.get(row.project_id);
      if (!existing || existing.kind !== 'approved' || existing.occurred_at < row.occurred_at) {
        candidateByProject.set(row.project_id, {
          id: row.id,
          occurred_at: row.occurred_at,
          kind: 'approved',
        });
      }
    } else {
      // viewed — only keep if no approved already won this project, AND
      // this is the project's true first view (not a re-visit).
      const existing = candidateByProject.get(row.project_id);
      if (existing?.kind === 'approved') continue;
      const firstView = firstViewByProject.get(row.project_id);
      if (!firstView || firstView.acked) continue; // first view was acked → don't re-celebrate
      // Use the first-view row (oldest), not whatever sort order returned.
      candidateByProject.set(row.project_id, {
        id: firstView.id,
        occurred_at: firstView.occurred_at,
        kind: 'viewed',
      });
    }
  }

  const candidates = Array.from(candidateByProject.entries()).map(([pid, c]) => ({
    projectId: pid,
    ...c,
  }));
  if (candidates.length === 0) return null;

  // Newest first — we surface only one card at a time.
  candidates.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  const chosen = candidates[0];

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customers:customer_id (name)')
    .eq('id', chosen.projectId)
    .maybeSingle();
  if (!project) return null;

  const customerRaw = project.customers as { name?: string } | { name?: string }[] | null;
  const customerName = Array.isArray(customerRaw)
    ? (customerRaw[0]?.name ?? null)
    : (customerRaw?.name ?? null);

  return {
    eventId: chosen.id,
    projectId: project.id as string,
    projectName: project.name as string,
    customerName,
    viewedAt: chosen.occurred_at,
    kind: chosen.kind,
  };
}
