import { Badge } from '@/components/ui/badge';
import { jobStatusTone, statusToneClass, statusToneIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type JobStatus, jobStatusLabels } from '@/lib/validators/job';

/**
 * Colour-coded pill for a job's lifecycle status. Paired with the kanban
 * column headers so the status reads the same in both places.
 */
export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  const tone = jobStatusTone[status];
  const Icon = statusToneIcon[tone];
  return (
    <Badge
      data-slot="job-status-badge"
      data-status={status}
      variant="outline"
      className={cn('gap-1 font-medium border', statusToneClass[tone], className)}
    >
      <Icon aria-hidden="true" className="size-3" />
      {jobStatusLabels[status]}
    </Badge>
  );
}
