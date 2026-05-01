/**
 * Read-only progress display. `% complete` is derived from cost-to-cost
 * (capped at 99 for active projects, 100 for complete, 0 for cancelled).
 *
 * The old "burn N%" sub-line was dropped from the project header — it
 * read as duplicate noise next to "% complete" without context, and the
 * over-budget signal it carried is now expressed by the budget tab's
 * spent-vs-committed bar (red when actuals exceed estimate).
 */
export function PercentCompleteEditor({ workStatusPct }: { workStatusPct: number }) {
  return (
    <div className="text-sm text-muted-foreground">
      <span>{workStatusPct}% complete</span>
    </div>
  );
}
