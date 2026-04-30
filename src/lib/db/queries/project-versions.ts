/**
 * Synthesised list of every signed version of a project's scope.
 *
 * Combines two data sources:
 *   - `project_scope_snapshots` (modern) — full per-version snapshot
 *     written from each customer-signed event
 *   - `projects.estimate_*` columns + `change_orders.applied_at`
 *     (legacy) — events that pre-date the snapshot table
 *
 * For rows backed by a snapshot, the modal viewer can pull the frozen
 * scope. For legacy rows, the modal shows a "Snapshot not available"
 * notice — the events still appear in the version list so audit trail
 * stays continuous.
 */

import { createClient } from '@/lib/supabase/server';

export type ProjectVersionListItem = {
  version_number: number;
  label: string;
  signed_at: string;
  signed_by_name: string | null;
  total_cents: number | null;
  /** Snapshot ID when available; null for legacy events. */
  snapshot_id: string | null;
  /** When set, this version came from a CO (link to /change-orders/[id]). */
  change_order_id: string | null;
};

export async function listProjectVersions(projectId: string): Promise<ProjectVersionListItem[]> {
  const supabase = await createClient();

  const [snapshotsRes, projectRes, cosRes] = await Promise.all([
    supabase
      .from('project_scope_snapshots')
      .select('id, version_number, label, signed_at, signed_by_name, total_cents, change_order_id')
      .eq('project_id', projectId)
      .order('version_number', { ascending: true }),
    supabase
      .from('projects')
      .select('estimate_sent_at, estimate_approved_at, estimate_approved_by_name, estimate_status')
      .eq('id', projectId)
      .maybeSingle(),
    supabase
      .from('change_orders')
      .select('id, title, applied_at, approved_by_name, cost_impact_cents, flow_version')
      .eq('project_id', projectId)
      .not('applied_at', 'is', null)
      .order('applied_at', { ascending: true }),
  ]);

  type SnapRow = {
    id: string;
    version_number: number;
    label: string | null;
    signed_at: string;
    signed_by_name: string | null;
    total_cents: number;
    change_order_id: string | null;
  };
  const snapshots = (snapshotsRes.data ?? []) as SnapRow[];

  // Snapshot-backed entries take precedence — they're the canonical audit row.
  const items: ProjectVersionListItem[] = snapshots.map((s) => ({
    version_number: s.version_number,
    label: s.label ?? `v${s.version_number}`,
    signed_at: s.signed_at,
    signed_by_name: s.signed_by_name,
    total_cents: s.total_cents,
    snapshot_id: s.id,
    change_order_id: s.change_order_id,
  }));

  // Legacy fill-in: if there's no snapshot for the original estimate
  // (project pre-dates 0164), synthesize a v1 entry from estimate_*
  // columns so the operator sees something.
  const project = projectRes.data as {
    estimate_sent_at: string | null;
    estimate_approved_at: string | null;
    estimate_approved_by_name: string | null;
    estimate_status: string | null;
  } | null;
  const hasSnapshotV1 = items.some((i) => i.version_number === 1);
  if (!hasSnapshotV1 && project?.estimate_status === 'approved' && project.estimate_approved_at) {
    items.unshift({
      version_number: 1,
      label: 'Original estimate (legacy)',
      signed_at: project.estimate_approved_at,
      signed_by_name: project.estimate_approved_by_name,
      total_cents: null,
      snapshot_id: null,
      change_order_id: null,
    });
  }

  // Legacy fill-in for applied COs: if a CO has applied_at but no
  // snapshot row, synthesize an entry. Modern flow always writes both.
  const cos = (cosRes.data ?? []) as {
    id: string;
    title: string | null;
    applied_at: string;
    approved_by_name: string | null;
    cost_impact_cents: number;
    flow_version: number;
  }[];
  for (const co of cos) {
    const alreadyInList = items.some((i) => i.change_order_id === co.id);
    if (alreadyInList) continue;
    items.push({
      version_number: items.length + 1,
      label: `CO — ${co.title ?? 'Untitled'} (legacy)`,
      signed_at: co.applied_at,
      signed_by_name: co.approved_by_name,
      total_cents: null,
      snapshot_id: null,
      change_order_id: co.id,
    });
  }

  // Keep chronological order (signed_at asc).
  items.sort((a, b) => a.signed_at.localeCompare(b.signed_at));
  return items;
}
