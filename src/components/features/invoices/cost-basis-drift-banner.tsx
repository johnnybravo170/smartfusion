import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/pricing/calculator';

function formatCad(cents: number): string {
  return formatCurrency(Math.abs(cents));
}

/**
 * Reconciliation banner on the draft cost-plus invoice. Compares the
 * pre-tax cost basis the invoice was billed against (frozen in
 * `line_items` at creation time) to the project's current cost rollup
 * (live read of time_entries + expenses + project_bills via the same
 * helper the action used). A non-zero delta means either:
 *   (a) more cost was logged after the draft was created — regenerate, or
 *   (b) the helper now sees a cost source the breakdown math doesn't —
 *       investigate before sending.
 *
 * Only renders on cost-plus drafts. The action's `warning` field
 * covers the creation-time check; this banner is the persistent
 * counterpart that doesn't go away on a refresh.
 */
export function CostBasisDriftBanner({
  projectId,
  billedCostBasisCents,
  currentCostBasisCents,
}: {
  projectId: string;
  /** Sum of the invoice's Labour + Materials line items. */
  billedCostBasisCents: number;
  /** What the helper says the basis would be today. */
  currentCostBasisCents: number;
}) {
  const delta = currentCostBasisCents - billedCostBasisCents;
  const direction = delta > 0 ? 'higher' : 'lower';

  return (
    <section className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300" />
      <div className="flex flex-1 flex-col gap-2 text-sm text-amber-900 dark:text-amber-100">
        <div>
          <p className="font-medium">Cost basis has drifted from this draft</p>
          <p className="text-amber-800/90 dark:text-amber-200/90">
            This draft billed {formatCad(billedCostBasisCents)} as the pre-tax cost basis, but
            today's rollup is {formatCad(currentCostBasisCents)} — {formatCad(delta)} {direction}.
            Either time/expenses were logged after this draft, or a cost source is missing from the
            invoice. Regenerate the draft, or check the budget tab to see which entries differ.
          </p>
        </div>
        <div>
          <Link
            href={`/projects/${projectId}?tab=budget`}
            className="inline-flex items-center rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-900 shadow-sm hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
          >
            Open project budget
          </Link>
        </div>
      </div>
    </section>
  );
}
