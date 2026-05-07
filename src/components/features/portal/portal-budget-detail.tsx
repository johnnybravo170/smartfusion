/**
 * Customer-facing per-bucket budget breakdown on the portal.
 *
 * Server component — receives a pre-computed `PortalBudgetSummary` and
 * renders one card per visible bucket plus a project-level rollup at
 * the bottom. The rollup pairs "Spent so far" against "Paid by you" on
 * a shared scale so the contractor's out-of-pocket position is visually
 * obvious without needing a separate Payments section.
 *
 * Visibility-gating happens upstream in the page; this component just
 * renders. Operator opts in per-tenant (default off) with optional
 * per-project override. See `shouldShowPortalBudget`.
 */

import type { PortalBudgetSummary } from '@/lib/db/queries/portal-budget';

const cadFormat = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
  maximumFractionDigits: 0,
});

function formatCents(cents: number): string {
  return cadFormat.format(cents / 100);
}

function pct(spent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((spent / total) * 100);
}

export function PortalBudgetDetail({ summary }: { summary: PortalBudgetSummary }) {
  if (summary.categories.length === 0 && summary.project_total_cents === 0) {
    return null;
  }

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold">Where the budget stands</h2>

      {/* Project-level rollup first — gives the customer the headline
          number before they scan the per-bucket details. */}
      <ProjectRollup summary={summary} />

      {summary.categories.length > 0 ? (
        <div className="mt-3 space-y-2">
          {summary.categories.map((cat) => {
            const p = pct(cat.spent_cents, cat.total_cents);
            const over = cat.spent_cents > cat.total_cents;
            return (
              <div key={cat.id} className="rounded-lg border p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{cat.name}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatCents(cat.spent_cents)} of {formatCents(cat.total_cents)}
                  </span>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      over ? 'bg-amber-500' : 'bg-emerald-500'
                    }`}
                    style={{ width: `${Math.min(100, p)}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>{p}% used</span>
                  {over ? <span className="font-medium text-amber-700">Over budget</span> : null}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Combined project-level view: spent-against-budget on top, paid-by-customer
 * on the same horizontal scale so the gap between them is visually obvious
 * without doing the math. Out-of-pocket sentence appears only when the
 * contractor has spent more than they've collected.
 *
 * Both bars share the project_total_cents budget as their full-width
 * reference, so the spent bar at 105% reads as visibly over and the paid
 * bar at 60% reads as visibly shorter.
 */
function ProjectRollup({ summary }: { summary: PortalBudgetSummary }) {
  const total = summary.project_total_cents;
  const spent = summary.project_spent_cents;
  const paid = summary.draws_paid_cents;

  const spentPct = pct(spent, total);
  const paidPct = pct(paid, total);
  const spentOver = spent > total;

  return (
    <div
      className={`rounded-lg border p-3 ${
        spentOver ? 'border-amber-300 bg-amber-50' : 'bg-muted/30'
      }`}
    >
      {/* Spent bar */}
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">Spent so far</span>
        <span className="text-sm font-semibold tabular-nums">
          {formatCents(spent)} of {formatCents(total)}{' '}
          <span className="text-xs font-normal text-muted-foreground">(incl. change orders)</span>
        </span>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
        <div
          className={`h-2 rounded-full transition-all ${
            spentOver ? 'bg-amber-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${Math.min(100, spentPct)}%` }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{spentPct}% of budget</span>
        {spentOver ? <span className="font-medium text-amber-700">Over budget</span> : null}
      </div>

      {summary.has_draws ? (
        <>
          {/* Paid bar — same scale as spent so the visual gap reads correctly. */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">Paid by you</span>
            <span className="text-sm font-semibold tabular-nums">{formatCents(paid)}</span>
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
            <div
              className="h-2 rounded-full bg-blue-500 transition-all"
              style={{ width: `${Math.min(100, paidPct)}%` }}
            />
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{paidPct}% of budget</div>
        </>
      ) : null}
    </div>
  );
}
