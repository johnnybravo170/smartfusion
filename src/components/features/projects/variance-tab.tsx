import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/pricing/calculator';

type VarianceData = {
  estimated_cents: number;
  committed_cents: number;
  actual_bills_cents: number;
  actual_expenses_cents: number;
  actual_total_cents: number;
  margin_at_risk_cents: number;
  by_category: {
    category: string;
    estimated_cents: number;
    committed_cents: number;
    actual_cents: number;
    margin_at_risk_cents: number;
  }[];
};

function StatBox({
  label,
  value,
  sub,
  highlight,
  danger,
  success,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  danger?: boolean;
  success?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${success ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800' : highlight ? 'bg-primary/5 border-primary/30' : ''} ${danger ? 'bg-destructive/5 border-destructive/30' : ''}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${danger ? 'text-destructive' : success ? 'text-emerald-700 dark:text-emerald-300' : highlight ? 'text-primary' : ''}`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export function VarianceTab({
  variance,
  lifecycleStage,
  projectId,
}: {
  variance: VarianceData;
  lifecycleStage?: string;
  /** Optional — when provided, category rows + section heading deep-link
   *  to the Budget tab so users can edit estimates from this view. */
  projectId?: string;
}) {
  const {
    estimated_cents,
    committed_cents,
    actual_bills_cents,
    actual_expenses_cents,
    actual_total_cents,
    margin_at_risk_cents,
    by_category,
  } = variance;

  const isComplete = lifecycleStage === 'complete';

  const marginPct =
    estimated_cents > 0
      ? Math.round(((estimated_cents - actual_total_cents) / estimated_cents) * 100)
      : null;

  // For closed projects costs are settled — only flag danger when actually over budget.
  // For in-flight projects, warn at >80% of estimate.
  const isAtRisk = isComplete
    ? margin_at_risk_cents < 0
    : actual_total_cents > estimated_cents * 0.8;

  const marginPositive = margin_at_risk_cents > 0;
  const marginLabel = isComplete ? 'Realized Margin' : 'Margin at Risk';
  const marginSubLabel = isComplete ? 'final margin' : 'remaining margin';

  return (
    <div className="space-y-6">
      {/* Top-level summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatBox label="Estimated Revenue" value={formatCurrency(estimated_cents)} highlight />
        <StatBox label="Committed (Open POs)" value={formatCurrency(committed_cents)} />
        <StatBox
          label="Actual Cost"
          value={formatCurrency(actual_total_cents)}
          sub={`Bills ${formatCurrency(actual_bills_cents)} · Expenses ${formatCurrency(actual_expenses_cents)}`}
          danger={isAtRisk}
        />
        <StatBox
          label={marginLabel}
          value={formatCurrency(margin_at_risk_cents)}
          sub={marginPct !== null ? `${marginPct}% ${marginSubLabel}` : undefined}
          danger={margin_at_risk_cents < 0}
          success={isComplete && marginPositive}
        />
      </div>

      {margin_at_risk_cents < 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Actual costs exceed estimated revenue — this job is over budget.
        </div>
      )}

      {/* By-category breakdown */}
      {by_category.length > 0 && (
        <div>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">By Category</h3>
            {projectId ? (
              <Link
                href={`/projects/${projectId}?tab=buckets`}
                prefetch={false}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Edit in Budget
                <ArrowRight className="size-3" />
              </Link>
            ) : null}
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Estimated</th>
                  <th className="px-3 py-2 text-right font-medium">Committed</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Margin Left</th>
                </tr>
              </thead>
              <tbody>
                {by_category.map((row) => (
                  <tr key={row.category} className="border-b last:border-0">
                    <td className="px-3 py-2 capitalize font-medium">
                      {projectId ? (
                        <Link
                          href={`/projects/${projectId}?tab=buckets&focus=${encodeURIComponent(row.category)}`}
                          prefetch={false}
                          className="hover:underline"
                        >
                          {row.category}
                        </Link>
                      ) : (
                        row.category
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">{formatCurrency(row.estimated_cents)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatCurrency(row.committed_cents)}
                    </td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatCurrency(row.actual_cents)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-medium ${row.margin_at_risk_cents < 0 ? 'text-destructive' : ''}`}
                    >
                      {formatCurrency(row.margin_at_risk_cents)}
                    </td>
                  </tr>
                ))}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td className="px-3 py-2">Total</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(estimated_cents)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(committed_cents)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(actual_total_cents)}</td>
                  <td
                    className={`px-3 py-2 text-right ${margin_at_risk_cents < 0 ? 'text-destructive' : 'text-primary'}`}
                  >
                    {formatCurrency(margin_at_risk_cents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {estimated_cents === 0 && actual_total_cents === 0 && (
        <p className="text-sm text-muted-foreground">
          No line items or bills recorded yet. Add line items in the Budget tab and log bills in the
          Spend tab.
        </p>
      )}
    </div>
  );
}
