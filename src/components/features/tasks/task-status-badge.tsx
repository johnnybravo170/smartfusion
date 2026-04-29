import { Badge } from '@/components/ui/badge';
import { taskStatusClass, taskStatusIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type TaskStatus, taskStatusLabels } from '@/lib/validators/task';

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
  return (
    <Badge
      data-slot="task-status-badge"
      data-status={status}
      variant="outline"
      className={cn('gap-1 font-medium border', taskStatusClass[status], className)}
    >
      {Icon ? <Icon aria-hidden="true" className="size-3" /> : null}
      <span className={hideLabelOnMobile ? 'hidden sm:inline' : undefined}>
        {taskStatusLabels[status]}
      </span>
    </Badge>
  );
}
