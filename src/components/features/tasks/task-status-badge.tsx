import { Badge } from '@/components/ui/badge';
import { taskStatusClass, taskStatusIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type TaskStatus, taskStatusLabels, taskStatusShortLabels } from '@/lib/validators/task';

/**
 * One-word status pill. The richer task palette (orange/purple/teal in
 * addition to the shared neutral/info/warning/etc.) lives in
 * `taskStatusClass` in status-tokens.ts.
 */
export function TaskStatusBadge({
  status,
  className,
  hideLabelOnMobile = false,
}: {
  status: TaskStatus;
  className?: string;
  /** Hide the status label below the `sm` breakpoint, leaving just the icon. */
  hideLabelOnMobile?: boolean;
}) {
  const Icon = taskStatusIcon[status];
  // Compact label for the badge — the icon already conveys "this is a
  // waiting state" so the "Waiting — " prefix is redundant. Full label
  // sits on the tooltip for clarity.
  const fullLabel = taskStatusLabels[status];
  const shortLabel = taskStatusShortLabels[status];
  return (
    <Badge
      data-slot="task-status-badge"
      data-status={status}
      variant="outline"
      className={cn('gap-1 font-medium border', taskStatusClass[status], className)}
      title={fullLabel}
    >
      {Icon ? <Icon aria-hidden="true" className="size-3" /> : null}
      <span className={hideLabelOnMobile ? 'hidden sm:inline' : undefined}>{shortLabel}</span>
    </Badge>
  );
}
