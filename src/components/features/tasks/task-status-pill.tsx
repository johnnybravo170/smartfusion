'use client';

/**
 * Click-to-change status pill. Renders the badge as a Select trigger so
 * the user gets the same colored chip with a dropdown built in. Used in
 * the project task list and the personal todo list.
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
import { taskStatusClass } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type TaskStatus, taskStatuses, taskStatusLabels } from '@/lib/validators/task';
import { changeStatusAction } from '@/server/actions/tasks';

export function TaskStatusPill({
  taskId,
  currentStatus,
}: {
  taskId: string;
  currentStatus: TaskStatus;
}) {
  const [pending, startTransition] = useTransition();

  function onChange(next: string) {
    if (next === currentStatus) return;
    startTransition(async () => {
      const res = await changeStatusAction({ id: taskId, status: next });
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <Select value={currentStatus} onValueChange={onChange} disabled={pending}>
      <SelectTrigger
        size="sm"
        className={cn(
          'h-6 w-auto gap-1 rounded-full border px-2 py-0 text-xs font-medium',
          taskStatusClass[currentStatus],
        )}
        aria-label="Change task status"
      >
        <SelectValue>{taskStatusLabels[currentStatus]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {taskStatuses.map((s) => (
          <SelectItem key={s} value={s}>
            {taskStatusLabels[s]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
