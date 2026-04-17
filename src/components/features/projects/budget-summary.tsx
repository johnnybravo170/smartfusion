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
    </div>
  );
}
