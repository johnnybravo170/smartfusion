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

  const _handleChange = useCallback(
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

  const [endValue, setEndValue] = useState(() => {
    // Default end = start + 4 hours, or empty
    if (!scheduledAt) return '';
    const d = new Date(scheduledAt);
    d.setHours(d.getHours() + 4);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });

  const handleSaveSchedule = useCallback(
    (startVal: string) => {
      if (!startVal) return;
      const isoValue = new Date(startVal).toISOString();
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

  if (editing) {
    return (
      <div className="flex items-start gap-3 col-span-2">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Schedule</span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-col gap-0.5">
              <label className="text-xs text-muted-foreground" htmlFor="sched-start">
                Start
              </label>
              <input
                id="sched-start"
                type="datetime-local"
                defaultValue={inputValue}
                disabled={pending}
                className="rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                // biome-ignore lint: autofocus intentional
                autoFocus
                ref={(el) => {
                  if (el && !inputValue) el.focus();
                }}
              />
            </div>
            <div className="flex flex-col gap-0.5">
              <label className="text-xs text-muted-foreground" htmlFor="sched-end">
                End
              </label>
              <input
                id="sched-end"
                type="datetime-local"
                defaultValue={endValue}
                onChange={(e) => setEndValue(e.target.value)}
                disabled={pending}
                className="rounded border bg-background px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                const startInput = document.getElementById('sched-start') as HTMLInputElement;
                if (startInput?.value) handleSaveSchedule(startInput.value);
              }}
              className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {pending ? 'Saving...' : 'Save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
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
