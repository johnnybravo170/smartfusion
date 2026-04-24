import { Badge } from '@/components/ui/badge';
import { taskStatusClass } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type TaskStatus, taskStatusLabels } from '@/lib/validators/task';

/**
 * One-word status pill. The richer task palette (orange/purple/teal in
 * addition to the shared neutral/info/warning/etc.) lives in
 * `taskStatusClass` in status-tokens.ts.
 */
export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  return (
    <Badge
      data-slot="task-status-badge"
      data-status={status}
      variant="outline"
      className={cn('font-medium border', taskStatusClass[status], className)}
    >
      {taskStatusLabels[status]}
    </Badge>
  );
}
