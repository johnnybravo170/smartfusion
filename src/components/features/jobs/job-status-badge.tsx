import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { type JobStatus, jobStatusLabels } from '@/lib/validators/job';

const STATUS_STYLES: Record<JobStatus, string> = {
  booked: 'bg-sky-100 text-sky-800 border-sky-200 hover:bg-sky-100',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100',
  complete: 'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200 hover:bg-slate-100',
};

/**
 * Colour-coded pill for a job's lifecycle status. Paired with the kanban
 * column headers so the status reads the same in both places.
 */
export function JobStatusBadge({ status, className }: { status: JobStatus; className?: string }) {
  return (
    <Badge
      data-slot="job-status-badge"
      data-status={status}
      variant="outline"
      className={cn('font-medium border', STATUS_STYLES[status], className)}
    >
      {jobStatusLabels[status]}
    </Badge>
  );
}
