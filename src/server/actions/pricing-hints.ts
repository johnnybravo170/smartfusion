'use server';

/**
 * Last-used pricing hints — embodies "memory as hint, not default"
 * (decision 6790ef2b). When the operator types a label on the
 * cost-line form, surface the prices they've used on similar items
 * across all their projects. Click to apply, never silent autofill.
 *
 * Implementation:
 *   - SQL function `find_pricing_hints` (migration 0182) does the
 *     heavy lifting: trigram similarity on label, optional unit
 *     filter, frequency aggregation, similarity-then-count-then-
 *     recency ranking.
 *   - No more category fallback. Tier-2 "any line in this category"
 *     was the main source of noise — surfacing $5,000/lot of grout
 *     when the user typed "Closets" just because both are
 *     `category: material`.
 */

import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type PricingHint = {
  unit_price_cents: number;
  unit: string;
  /** Most recent ISO date this price was used. */
  last_used_at: string;
  /** Source label of the most-recent line — useful for the tooltip. */
  source_label: string;
  /** Source project id of the most-recent line. */
  source_project_id: string;
  /** How many times this exact (price, unit) has been used in
   *  matching lines. Surfaced so the UI can lightly indicate
   *  "you've used this 8 times". */
  use_count: number;
  /** Trigram similarity 0..1. Surfaced so the UI can hide low-
   *  confidence matches if it wants — currently the SQL threshold
   *  already keeps it sane. */
  similarity: number;
};

export async function getPricingHintsAction(input: {
  label: string;
  unit?: string;
  excludeProjectId?: string;
}): Promise<PricingHint[]> {
  const tenant = await getCurrentTenant();
  if (!tenant) return [];

  const trimmed = (input.label ?? '').trim();
  if (trimmed.length < 2) return [];

  const admin = createAdminClient();
  const { data, error } = await admin.rpc('find_pricing_hints', {
    p_label: trimmed,
    p_unit: input.unit?.trim() || null,
    p_exclude_project_id: input.excludeProjectId ?? null,
  });

  if (error) {
    console.error('find_pricing_hints failed:', error.message);
    return [];
  }

  type Row = {
    unit_price_cents: number;
    unit: string;
    source_label: string;
    source_project_id: string;
    last_used_at: string;
    use_count: number;
    similarity: number;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    unit_price_cents: r.unit_price_cents,
    unit: r.unit,
    source_label: r.source_label,
    source_project_id: r.source_project_id,
    last_used_at: r.last_used_at,
    use_count: r.use_count,
    similarity: r.similarity,
  }));
}
