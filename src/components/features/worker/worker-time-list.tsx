'use client';

import { Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { WorkerTimeEntry } from '@/lib/db/queries/worker-time';
import { deleteWorkerTimeAction } from '@/server/actions/worker-time';

type Props = {
  entries: WorkerTimeEntry[];
  /** Tenant-level flag. When true, workers can edit/delete entries older than 48h. */
  canEditOld: boolean;
};

const GRACE_MS = 48 * 60 * 60 * 1000;

function weekStart(iso: string): string {
  const d = new Date(`${iso}T00:00`);
  const day = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function formatWeek(iso: string, tz: string): string {
  const start = new Date(`${iso}T00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const s = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
  }).format(start);
  const e = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: sameMonth ? undefined : 'short',
    day: 'numeric',
  }).format(end);
  return `${s} – ${e}`;
}

function formatDay(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${iso}T00:00`));
}

function isWithinGrace(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < GRACE_MS;
}

export function WorkerTimeList({ entries, canEditOld }: Props) {
  const tz = useTenantTimezone();
  const [pending, startTransition] = useTransition();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No time logged yet. Tap &ldquo;Log time&rdquo; to add your first entry.
      </p>
    );
  }

  // Group by week, then by day within each week. Entries arrive newest-first
  // (listWorkerTimeEntries orders by entry_date desc), so iteration order
  // preserves that.
  const weeks = new Map<string, Map<string, WorkerTimeEntry[]>>();
  for (const entry of entries) {
    const wkKey = weekStart(entry.entry_date);
    let byDay = weeks.get(wkKey);
    if (!byDay) {
      byDay = new Map();
      weeks.set(wkKey, byDay);
    }
    const arr = byDay.get(entry.entry_date) ?? [];
    arr.push(entry);
    byDay.set(entry.entry_date, arr);
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteWorkerTimeAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Entry deleted.');
    });
  }

  function canMutate(entry: WorkerTimeEntry): boolean {
    return canEditOld || isWithinGrace(entry.created_at);
  }

  return (
    <div className="flex flex-col gap-5">
      {Array.from(weeks.entries()).map(([weekKey, byDay]) => {
        const weekTotal = Array.from(byDay.values())
          .flat()
          .reduce((s, r) => s + r.hours, 0);
        return (
          <section key={weekKey} className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">{formatWeek(weekKey, tz)}</h2>
              <span className="text-xs text-muted-foreground">{weekTotal.toFixed(2)}h</span>
            </div>
            <div className="space-y-3">
              {Array.from(byDay.entries()).map(([dayKey, rows]) => {
                const dayTotal = rows.reduce((s, r) => s + r.hours, 0);
                return (
                  <div key={dayKey} className="rounded-lg border">
                    <div className="flex items-center justify-between border-b bg-muted/40 px-3 py-2">
                      <span className="text-sm font-medium">{formatDay(dayKey, tz)}</span>
                      <span className="text-xs font-medium text-muted-foreground">
                        {dayTotal.toFixed(2)}h
                      </span>
                    </div>
                    <div className="divide-y">
                      {rows.map((entry) => {
                        const editable = canMutate(entry);
                        return (
                          <div key={entry.id} className="flex items-start gap-3 p-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2 text-sm">
                                <span className="font-medium">{entry.hours.toFixed(2)}h</span>
                                <span className="text-muted-foreground truncate">
                                  {entry.project_name ?? 'Unknown project'}
                                  {entry.budget_category_name
                                    ? ` · ${entry.budget_category_name}`
                                    : ''}
                                </span>
                              </div>
                              {entry.notes ? (
                                <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                                  {entry.notes}
                                </p>
                              ) : null}
                            </div>
                            {editable ? (
                              <div className="flex shrink-0 items-center gap-1">
                                <Button asChild variant="ghost" size="icon" aria-label="Edit entry">
                                  <Link href={`/w/time/${entry.id}/edit`}>
                                    <Pencil className="size-4" />
                                  </Link>
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  disabled={pending}
                                  onClick={() => handleDelete(entry.id)}
                                  aria-label="Delete entry"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
