/**
 * Branch-step evaluation for the AR engine.
 *
 * The `branch` step type carries a JSONB config of the form:
 *
 *   {
 *     "conditions": [
 *       { "kind": "estimate_viewed_multiple", "within_hours": 24, "min_views": 2, "jump_to_position": 5 },
 *       { "kind": "estimate_viewed",          "skip": 1 },
 *       { "kind": "estimate_not_viewed",      "skip": 0 }
 *     ]
 *   }
 *
 * Conditions are evaluated in order. The first match wins. A match advances
 * the enrollment via either an absolute `jump_to_position` or a relative
 * `skip` (added to the current position). If no condition matches, the
 * caller advances normally (currentPosition + 1).
 *
 * Resource lookup: the executor reads the enrollment's `metadata` jsonb for
 * a `quote_id` or `project_id` to identify which estimate's view stats to
 * inspect. The system quote-followup sequence emits `quote_sent` with
 * `{ quote_id }`, so that's the primary integration today.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type BranchCondition =
  | {
      kind: 'estimate_viewed';
      jump_to_position?: number;
      skip?: number;
    }
  | {
      kind: 'estimate_viewed_multiple';
      within_hours?: number;
      min_views?: number;
      jump_to_position?: number;
      skip?: number;
    }
  | {
      kind: 'estimate_not_viewed';
      jump_to_position?: number;
      skip?: number;
    };

export type BranchConfig = {
  conditions?: BranchCondition[];
};

export type BranchOutcome = {
  /** Absolute position to jump to. When undefined, caller should advance normally. */
  jumpToPosition?: number;
};

/**
 * Returns the absolute next position the enrollment should jump to, or
 * undefined if no branch condition matched (caller advances normally).
 */
export async function evaluateBranch(
  admin: SupabaseClient,
  config: BranchConfig,
  metadata: Record<string, unknown>,
  currentPosition: number,
  now: Date,
): Promise<BranchOutcome> {
  const conditions = config?.conditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return {};

  // Resource resolution: prefer quote_id (legacy quotes flow), fall back to
  // project_id (project-based estimates). resource_type matches.
  let resourceType: 'quote' | 'estimate' | null = null;
  let resourceId: string | null = null;
  if (typeof metadata.quote_id === 'string') {
    resourceType = 'quote';
    resourceId = metadata.quote_id;
  } else if (typeof metadata.project_id === 'string') {
    resourceType = 'estimate';
    resourceId = metadata.project_id;
  }
  if (!resourceType || !resourceId) return {};

  const { data, error } = await admin
    .from('public_page_views')
    .select('viewed_at')
    .eq('resource_type', resourceType)
    .eq('resource_id', resourceId)
    .order('viewed_at', { ascending: false });
  if (error) return {};
  const views = (data ?? []) as Array<{ viewed_at: string }>;
  const totalViews = views.length;

  for (const cond of conditions) {
    const target = resolveTarget(cond, currentPosition);
    if (target === null) continue; // condition has no skip/jump → ignore

    if (cond.kind === 'estimate_viewed' && totalViews > 0) {
      return { jumpToPosition: target };
    }

    if (cond.kind === 'estimate_not_viewed' && totalViews === 0) {
      return { jumpToPosition: target };
    }

    if (cond.kind === 'estimate_viewed_multiple') {
      const minViews = cond.min_views ?? 2;
      const withinHours = cond.within_hours ?? 24;
      const cutoff = now.getTime() - withinHours * 60 * 60 * 1000;
      const recentCount = views.filter((v) => new Date(v.viewed_at).getTime() >= cutoff).length;
      if (recentCount >= minViews) {
        return { jumpToPosition: target };
      }
    }
  }

  return {};
}

function resolveTarget(cond: BranchCondition, currentPosition: number): number | null {
  if (typeof cond.jump_to_position === 'number') return cond.jump_to_position;
  if (typeof cond.skip === 'number') return currentPosition + cond.skip + 1;
  return null;
}
