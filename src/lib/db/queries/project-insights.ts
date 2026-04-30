/**
 * Henry-supplied insight strip on the Budget page (Executing mode).
 *
 * Produces 1-2 actionable observations about the project's current
 * state — "Bathroom 18% over budget", "3 unsent changes since v2",
 * "Plumbing finished under budget". Rule-based v1, no LLM in the
 * critical path. Operator clicks an insight → routes to the relevant
 * surface (diff review, Spend tab filtered, etc).
 *
 * The "Henry suggests" framing matches decision 6790ef2b — Henry
 * surfaces things to consider, never commands.
 */

import { getBudgetVsActual } from './project-budget-categories';
import { getUnsentDiff } from './project-scope-diff';

export type ProjectInsight = {
  /** Stable kind for telemetry / styling. */
  kind:
    | 'unsent_changes'
    | 'section_over_budget'
    | 'section_under_budget'
    | 'pace_concern'
    | 'on_track';
  /** Operator-facing copy, plain English. */
  message: string;
  /** Optional deep link relative to the project page. */
  href?: string;
  /** 0-100 — drives ordering when multiple insights compete. */
  priority: number;
  /** Tone for visual styling. */
  tone: 'amber' | 'emerald' | 'blue' | 'neutral';
};

/**
 * Compute up to 2 insights worth surfacing. Ordered by descending
 * priority. Empty array means "nothing actionable" — caller shows a
 * quiet "everything tracking" line if desired.
 */
export async function getProjectInsights(projectId: string): Promise<ProjectInsight[]> {
  const [diff, budget] = await Promise.all([
    getUnsentDiff(projectId),
    getBudgetVsActual(projectId),
  ]);

  const candidates: ProjectInsight[] = [];

  // 1. Unsent changes are the highest-priority interrupt — operator
  //    has to act before customer-facing state advances.
  if (diff.has_baseline && diff.total_change_count > 0) {
    const customerImpacting = diff.suggested_co_count;
    candidates.push({
      kind: 'unsent_changes',
      message:
        customerImpacting > 0
          ? `${diff.total_change_count} unsent ${diff.total_change_count === 1 ? 'change' : 'changes'} since v${diff.baseline_version} — ${customerImpacting} ${customerImpacting === 1 ? 'looks customer-impacting' : 'look customer-impacting'}.`
          : `${diff.total_change_count} unsent ${diff.total_change_count === 1 ? 'change' : 'changes'} since v${diff.baseline_version}.`,
      href: `?tab=budget&review=diff`,
      priority: 90,
      tone: 'amber',
    });
  }

  // 2. Sections meaningfully over budget. >10% delta vs estimate, with
  //    a $250 minimum so tiny categories don't trigger noisy messages.
  for (const line of budget.lines) {
    if (line.estimate_cents <= 0) continue;
    const ratio = line.actual_cents / line.estimate_cents;
    const delta = line.actual_cents - line.estimate_cents;
    if (ratio > 1.1 && delta > 25_000) {
      const overPct = Math.round((ratio - 1) * 100);
      candidates.push({
        kind: 'section_over_budget',
        message: `${line.budget_category_name} is ${overPct}% over budget.`,
        href: `?tab=costs&focus=${encodeURIComponent(line.budget_category_name)}`,
        priority: 70 + Math.min(overPct, 20),
        tone: 'amber',
      });
    }
  }

  // 3. Sections substantially under budget AND mostly spent. Useful
  //    flag for "good time to lock this in / move budget elsewhere".
  for (const line of budget.lines) {
    if (line.estimate_cents <= 0) continue;
    const ratio = line.actual_cents / line.estimate_cents;
    if (ratio >= 0.85 && ratio < 0.95) {
      candidates.push({
        kind: 'section_under_budget',
        message: `${line.budget_category_name} finished close to or under budget.`,
        priority: 40,
        tone: 'emerald',
      });
    }
  }

  // 4. All-on-track fallback — a single quiet line so the strip
  //    never looks "missing". Only emitted when there are no
  //    higher-priority insights.
  if (candidates.length === 0) {
    candidates.push({
      kind: 'on_track',
      message: 'Everything tracking. No action needed.',
      priority: 10,
      tone: 'neutral',
    });
  }

  return candidates.sort((a, b) => b.priority - a.priority).slice(0, 2);
}
