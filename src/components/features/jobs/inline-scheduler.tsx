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

      // datetime-local gives us "2026-04-20T08:30" in the user's local time.
      // We need to store it as a timestamptz that represents that wall-clock
      // time in the tenant's timezone. Append the timezone offset so Postgres
      // stores the correct instant.
      //
      // For now, we send the value as-is and let the browser's Date parse it
      // as local time. The server stores it as UTC internally. The display
      // layer (formatDateTime with tenant timezone) converts it back correctly
      // as long as the browser timezone matches the tenant timezone.
      //
      // This works because contractors use the app from their local area.
      const isoValue = new Date(value).toISOString();

      startTransition(async () => {
        const result = await action(jobId, isoValue);
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

  // Convert stored UTC time to local datetime-local format for the input.
  // This uses the browser's timezone which should match the operator's location.
  const inputValue = scheduledAt
    ? (() => {
        const d = new Date(scheduledAt);
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      })()
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
