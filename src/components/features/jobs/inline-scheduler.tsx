'use client';

import { CalendarClock } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { formatDateTime } from '@/lib/date/format';

export function InlineScheduler({
  jobId,
  scheduledAt,
  timezone,
  action,
}: {
  jobId: string;
  scheduledAt: string | null;
  timezone: string;
  action: (jobId: string, scheduledAt: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      if (!value) return;

      startTransition(async () => {
        const result = await action(jobId, new Date(value).toISOString());
        if (result.ok) {
          toast.success('Job scheduled.');
          setEditing(false);
          router.refresh();
        } else {
          toast.error(result.error ?? 'Failed to schedule.');
        }
      });
    },
    [jobId, action, router],
  );

  // Convert ISO to datetime-local format for the input
  const inputValue = scheduledAt
    ? new Date(scheduledAt).toISOString().slice(0, 16)
    : '';

  if (editing) {
    return (
      <div className="flex items-start gap-3">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Scheduled</span>
          <input
            type="datetime-local"
            defaultValue={inputValue}
            onChange={handleChange}
            disabled={pending}
            className="rounded border bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            // biome-ignore lint: autofocus is intentional for inline edit
            autoFocus
            onBlur={() => !pending && setEditing(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="flex items-start gap-3 rounded-md px-1 -mx-1 py-1 -my-1 text-left transition-colors hover:bg-muted/50"
    >
      <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Scheduled</span>
        <span className="text-sm text-foreground">
          {scheduledAt ? formatDateTime(scheduledAt, { timezone }) : 'Click to schedule'}
        </span>
      </div>
    </button>
  );
}
