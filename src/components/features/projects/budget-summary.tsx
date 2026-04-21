'use client';

/**
 * Budget summary component for project overview tab.
 * Shows total estimate vs actual vs remaining with a progress bar.
 */

import type { BudgetSummary } from '@/lib/db/queries/project-buckets';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';

export function BudgetSummaryCard({ budget }: { budget: BudgetSummary }) {
  const { total_estimate_cents, total_actual_cents, total_remaining_cents } = budget;
  const progress =
    total_estimate_cents > 0
      ? Math.min(Math.round((total_actual_cents / total_estimate_cents) * 100), 100)
      : 0;
  const isOverBudget = total_remaining_cents < 0;

  return (
    <div className="rounded-lg border p-6">
      <h3 className="mb-4 text-sm font-medium text-muted-foreground">Budget Overview</h3>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div>
          <p className="text-xs text-muted-foreground">Estimated</p>
          <p className="text-lg font-semibold">{formatCurrency(total_estimate_cents)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Spent</p>
          <p className="text-lg font-semibold">{formatCurrency(total_actual_cents)}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Remaining</p>
          <p className={cn('text-lg font-semibold', isOverBudget && 'text-red-600')}>
            {formatCurrency(Math.abs(total_remaining_cents))}
            {isOverBudget ? ' over' : ''}
          </p>
        </div>
      </div>

      <div className="h-2 w-full rounded-full bg-gray-200">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            isOverBudget ? 'bg-red-500' : progress > 80 ? 'bg-yellow-500' : 'bg-green-500',
          )}
          style={{ width: `${Math.min(progress, 100)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{progress}% of budget used</p>

      {budget.lines.length > 0 && (
        <div className="mt-6 overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50 text-xs">
                <th className="px-3 py-2 text-left font-medium">Bucket</th>
                <th className="px-3 py-2 text-right font-medium">Estimate</th>
                <th className="px-3 py-2 text-right font-medium">Labour</th>
                <th className="px-3 py-2 text-right font-medium">Expenses</th>
                <th className="px-3 py-2 text-right font-medium">Actual</th>
                <th className="px-3 py-2 text-right font-medium">Remaining</th>
              </tr>
            </thead>
            <tbody>
              {budget.lines.map((line) => {
                const over = line.remaining_cents < 0;
                const pct =
                  line.estimate_cents > 0
                    ? Math.round((line.actual_cents / line.estimate_cents) * 100)
                    : 0;
                return (
                  <tr key={line.bucket_id} className="border-b last:border-b-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{line.bucket_name}</div>
                      <div className="text-xs text-muted-foreground">
                        {line.section} · {pct}%
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCurrency(line.estimate_cents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(line.labor_cents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                      {formatCurrency(line.expense_cents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {formatCurrency(line.actual_cents)}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums font-medium',
                        over && 'text-red-600',
                      )}
                    >
                      {formatCurrency(Math.abs(line.remaining_cents))}
                      {over ? ' over' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
