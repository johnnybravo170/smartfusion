'use client';

/**
 * Drop-in alternative to the board's drag-drop: a shadcn Select that fires
 * `changeJobStatusAction` on change. Used on the detail page and exercised
 * by the E2E suite (drag-drop is too fragile for headless tests).
 */

import { useTransition } from 'react';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { type JobStatus, jobStatuses, jobStatusLabels } from '@/lib/validators/job';
import { changeJobStatusAction } from '@/server/actions/jobs';

export function JobStatusSelect({
  jobId,
  currentStatus,
}: {
  jobId: string;
  currentStatus: JobStatus;
}) {
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    if (next === currentStatus) return;
    startTransition(async () => {
      const result = await changeJobStatusAction({ id: jobId, status: next });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`Moved to ${jobStatusLabels[next as JobStatus]}`);
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Change status
      </span>
      <Select value={currentStatus} onValueChange={onChange} disabled={pending}>
        <SelectTrigger className="w-[180px]" aria-label="Change job status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {jobStatuses.map((s) => (
            <SelectItem key={s} value={s}>
              {jobStatusLabels[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
