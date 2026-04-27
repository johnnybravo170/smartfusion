/**
 * Read-only progress display. Replaces the old manual percent_complete
 * editor — `% complete` is now derived from cost-to-cost (capped at 99
 * for active projects, 100 for complete, 0 for cancelled). The "burn"
 * sub-line shows uncapped cost / est-revenue so over-budget jobs are
 * visible at a glance (red when burn > 100).
 */
import { cn } from '@/lib/utils';

export function PercentCompleteEditor({
  workStatusPct,
  costBurnPct,
}: {
  workStatusPct: number;
  costBurnPct: number;
}) {
  const overBudget = costBurnPct > 100;
  return (
    <div className="flex items-baseline gap-3 text-sm text-muted-foreground">
      <span>{workStatusPct}% complete</span>
      <span
        className={cn('text-xs', overBudget ? 'text-destructive font-medium' : '')}
        title="Cost burn: cost incurred / estimated revenue (uncapped)"
      >
        burn {costBurnPct}%
      </span>
    </div>
  );
}
