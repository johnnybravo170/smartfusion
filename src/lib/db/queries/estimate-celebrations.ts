/**
 * "🎉 Customer just opened your estimate" celebration — returns the most
 * recent unacknowledged first-view event for the current operator's
 * tenant, or null when there's nothing to celebrate.
 *
 * Each project can fire this once. `project_events.acknowledged_at` is
 * backfilled for historical rows (see migration 0092), so on deploy the
 * card won't surface anything that happened before the feature existed.
 */

import { createClient } from '@/lib/supabase/server';

export type EstimateCelebration = {
  eventId: string;
  projectId: string;
  projectName: string;
  customerName: string | null;
  viewedAt: string;
};

export async function getPendingEstimateCelebration(): Promise<EstimateCelebration | null> {
  const supabase = await createClient();

  // Pull all unacknowledged estimate_viewed events for the tenant, newest
  // first. Then keep only the FIRST view per project (min occurred_at) —
  // so re-visits by the same customer don't celebrate again.
  const { data: events, error } = await supabase
    .from('project_events')
    .select('id, project_id, occurred_at')
    .eq('kind', 'estimate_viewed')
    .is('acknowledged_at', null)
    .order('occurred_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`Celebration: ${error.message}`);
  if (!events?.length) return null;

  // Per project: keep only the earliest (first) view row. If there are
  // multiple unacknowledged rows, we acknowledge ALL of them when the
  // operator dismisses, but we only surface the earliest one.
  const projectIds = Array.from(new Set(events.map((e) => e.project_id as string)));

  // For each project, find the true first-view event (might be acked
  // already if an older row is acked — in that case this project has
  // already been celebrated once and we skip it).
  const { data: allFirstViews } = await supabase
    .from('project_events')
    .select('project_id, occurred_at, acknowledged_at, id')
    .eq('kind', 'estimate_viewed')
    .in('project_id', projectIds)
    .order('occurred_at', { ascending: true });
  if (!allFirstViews?.length) return null;

  const firstByProject = new Map<string, { id: string; occurred_at: string; acked: boolean }>();
  for (const row of allFirstViews) {
    const pid = row.project_id as string;
    if (!firstByProject.has(pid)) {
      firstByProject.set(pid, {
        id: row.id as string,
        occurred_at: row.occurred_at as string,
        acked: row.acknowledged_at !== null,
      });
    }
  }

  // Pick the newest first-view that's still unacknowledged.
  const candidates = Array.from(firstByProject.values())
    .filter((f) => !f.acked)
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1));
  const chosen = candidates[0];
  if (!chosen) return null;

  // Look up project + customer for the card.
  const chosenProjectId = Array.from(firstByProject.entries()).find(
    ([, v]) => v.id === chosen.id,
  )?.[0];
  if (!chosenProjectId) return null;

  const { data: project } = await supabase
    .from('projects')
    .select('id, name, customers:customer_id (name)')
    .eq('id', chosenProjectId)
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
  };
}
