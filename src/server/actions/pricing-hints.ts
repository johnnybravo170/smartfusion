'use server';

/**
 * Last-used pricing hints — embodies "memory as hint, not default"
 * (decision 6790ef2b). When the operator focuses on a unit price field
 * on a cost line, surface the last 3 distinct prices they've used on
 * similar items across all their projects. Click to apply, never silent
 * auto-fill.
 *
 * Match strategy:
 *   1. Exact label match (case-insensitive) within the last 90 days
 *   2. Fallback to category match if fewer than 3 hits found
 *   3. Distinct on price + unit; collapse repeats to a single entry
 *
 * Returns an empty array on no matches — caller hides the hint UI.
 */

import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type PricingHint = {
  unit_price_cents: number;
  unit: string;
  /** Most recent ISO date this price was used. */
  last_used_at: string;
  /** Source label (may differ slightly from query label — useful for context). */
  source_label: string;
  /** Source project_id; used by the UI to label "from {project name}". */
  source_project_id: string;
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export async function getPricingHintsAction(input: {
  label: string;
  category?: string;
  excludeProjectId?: string;
}): Promise<PricingHint[]> {
  const tenant = await getCurrentTenant();
  if (!tenant) return [];

  const trimmed = (input.label ?? '').trim();
  if (trimmed.length < 2) return [];

  const since = new Date(Date.now() - NINETY_DAYS_MS).toISOString();
  const admin = createAdminClient();

  // Tier 1: exact label match (case-insensitive) on the same tenant in
  // the last 90 days. ilike is sufficient — we only need recent
  // operator-typed labels, not a full-text search across descriptions.
  const labelRes = await admin
    .from('project_cost_lines')
    .select('unit_price_cents, unit, label, project_id, created_at, projects!inner(tenant_id)')
    .eq('projects.tenant_id', tenant.id)
    .gte('created_at', since)
    .ilike('label', trimmed)
    .order('created_at', { ascending: false })
    .limit(20);

  type Row = {
    unit_price_cents: number;
    unit: string;
    label: string;
    project_id: string;
    created_at: string;
  };
  const labelRows = ((labelRes.data ?? []) as unknown as Row[]).filter(
    (r) => !input.excludeProjectId || r.project_id !== input.excludeProjectId,
  );

  const hits: PricingHint[] = [];
  const seen = new Set<string>();
  function pushUnique(r: Row) {
    const key = `${r.unit_price_cents}-${r.unit}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({
      unit_price_cents: r.unit_price_cents,
      unit: r.unit,
      last_used_at: r.created_at,
      source_label: r.label,
      source_project_id: r.project_id,
    });
  }

  for (const r of labelRows) {
    if (hits.length >= 3) break;
    pushUnique(r);
  }

  // Tier 2: category fallback if we still don't have 3 hits.
  if (hits.length < 3 && input.category) {
    const catRes = await admin
      .from('project_cost_lines')
      .select('unit_price_cents, unit, label, project_id, created_at, projects!inner(tenant_id)')
      .eq('projects.tenant_id', tenant.id)
      .eq('category', input.category)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(40);

    const catRows = ((catRes.data ?? []) as unknown as Row[]).filter(
      (r) => !input.excludeProjectId || r.project_id !== input.excludeProjectId,
    );
    for (const r of catRows) {
      if (hits.length >= 3) break;
      pushUnique(r);
    }
  }

  return hits;
}
