/**
 * Customer-facing per-bucket budget breakdown on the portal.
 *
 * Server component — receives a pre-computed `PortalBudgetSummary` and
 * renders one card per visible bucket plus a project-level rollup line
 * at the bottom. Visibility-gating happens upstream in the page; this
 * component just renders.
 *
 * Operator opts in per-tenant (default off) with optional per-project
 * override. See `shouldShowPortalBudget`.
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

  const projectPct = pct(summary.project_spent_cents, summary.project_total_cents);
  const projectOver = summary.project_spent_cents > summary.project_total_cents;

  return (
    <div className="mb-8">
      <h2 className="mb-3 text-sm font-semibold">Where the budget stands</h2>
      <div className="space-y-2">
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

      {/* Project-level rollup. Includes uncategorized change-order impact
          when present, so this number can exceed the sum of per-bucket
          totals — that's the right behavior for the homeowner's view. */}
      <div
        className={`mt-3 rounded-lg border p-3 ${
          projectOver ? 'border-amber-300 bg-amber-50' : 'bg-muted/30'
        }`}
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-semibold">Total spent so far</span>
          <span className="text-sm font-semibold tabular-nums">
            {formatCents(summary.project_spent_cents)} of {formatCents(summary.project_total_cents)}{' '}
            <span className="text-xs font-normal text-muted-foreground">(incl. change orders)</span>
          </span>
        </div>
        <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-2 rounded-full transition-all ${
              projectOver ? 'bg-amber-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(100, projectPct)}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{projectPct}% used</span>
          {projectOver ? <span className="font-medium text-amber-700">Over budget</span> : null}
        </div>
      </div>

      {summary.has_draws ? <PaymentsBlock summary={summary} /> : null}
    </div>
  );
}

/**
 * Payments block — shows what the customer has been billed and paid
 * vs what's been spent on the job. Surfaces the contractor's
 * out-of-pocket position when spent > paid (common at job midpoint).
 */
function PaymentsBlock({ summary }: { summary: PortalBudgetSummary }) {
  const outstanding = summary.draws_invoiced_cents - summary.draws_paid_cents;
  // Out-of-pocket is what's been spent minus what the contractor has
  // actually collected. Negative means contractor has billed/collected
  // ahead of spend (rare but possible early in a job).
  const outOfPocket = summary.project_spent_cents - summary.draws_paid_cents;

  return (
    <div className="mt-4 rounded-lg border p-3">
      <p className="mb-2 text-sm font-semibold">Payments</p>
      <div className="space-y-1.5 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Invoiced to you</span>
          <span className="tabular-nums">{formatCents(summary.draws_invoiced_cents)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Paid by you</span>
          <span className="tabular-nums">{formatCents(summary.draws_paid_cents)}</span>
        </div>
        {outstanding > 0 ? (
          <div className="flex items-center justify-between">
            <span className="text-amber-700">Outstanding</span>
            <span className="tabular-nums font-medium text-amber-700">
              {formatCents(outstanding)}
            </span>
          </div>
        ) : null}
      </div>

      {outOfPocket > 0 ? (
        <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">
          Your contractor has spent{' '}
          <strong className="text-foreground">{formatCents(summary.project_spent_cents)}</strong> on
          the job and collected{' '}
          <strong className="text-foreground">{formatCents(summary.draws_paid_cents)}</strong> from
          you so far. They&rsquo;re currently{' '}
          <strong className="text-foreground">{formatCents(outOfPocket)}</strong> out of pocket.
        </p>
      ) : null}
    </div>
  );
}
