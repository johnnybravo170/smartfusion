'use client';

import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { ReasonTag } from '@/lib/db/queries/worker-unavailability';
import {
  bulkAssignDatesAction,
  deleteAssignmentsByDatesAction,
  moveAssignmentsAction,
} from '@/server/actions/project-assignments';
import {
  addUnavailabilityAction,
  moveUnavailabilityRangeAction,
  removeUnavailabilityRangeAction,
} from '@/server/actions/worker-unavailability';

export type ScheduleCell =
  | { type: 'scheduled'; projectName: string }
  | {
      type: 'unavailable';
      reasonLabel: string;
      reasonTag: ReasonTag;
      reasonText: string | null;
    }
  | {
      type: 'both';
      projectName: string;
      reasonLabel: string;
      reasonTag: ReasonTag;
      reasonText: string | null;
    }
  | { type: 'empty' };

type Worker = { profile_id: string; display_name: string };

type Props = {
  projectId: string;
  startDate: string;
  days: number;
  workers: Worker[];
  cells: Record<string, ScheduleCell>;
};

type BarType = 'sched' | 'unav';

type Run = {
  type: BarType;
  workerId: string;
  startIdx: number;
  endIdx: number;
  label: string;
  reasonTag?: ReasonTag;
  reasonText?: string | null;
};

type Interaction =
  | { kind: 'select'; workerId: string; startIdx: number; endIdx: number }
  | {
      kind: 'move' | 'resize-l' | 'resize-r';
      bar: Run;
      grabIdx: number;
      curStart: number;
      curEnd: number;
      moved: boolean;
    };

function addDays(iso: string, offset: number, tz: string): string {
  const d = new Date(`${iso}T00:00`);
  d.setDate(d.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function rangeDates(dates: string[], s: number, e: number): string[] {
  const out: string[] = [];
  for (let i = s; i <= e; i++) out.push(dates[i]);
  return out;
}

function buildRunsFor(
  workerId: string,
  dates: string[],
  perDay: ScheduleCell[],
  type: BarType,
): Run[] {
  const runs: Run[] = [];
  let i = 0;
  const keyOf = (c: ScheduleCell): string | null => {
    if (type === 'sched') {
      if (c.type === 'scheduled' || c.type === 'both') return c.projectName;
      return null;
    }
    if (c.type === 'unavailable' || c.type === 'both') return c.reasonLabel;
    return null;
  };
  while (i < dates.length) {
    const key = keyOf(perDay[i]);
    if (!key) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < dates.length && keyOf(perDay[j + 1]) === key) j++;
    const sample = perDay[i];
    let reasonTag: ReasonTag | undefined;
    let reasonText: string | null | undefined;
    if (type === 'unav' && (sample.type === 'unavailable' || sample.type === 'both')) {
      reasonTag = sample.reasonTag;
      reasonText = sample.reasonText;
    }
    runs.push({ type, workerId, startIdx: i, endIdx: j, label: key, reasonTag, reasonText });
    i = j + 1;
  }
  return runs;
}

export function CrewScheduleGrid({ projectId, startDate, days, workers, cells }: Props) {
  const tz = useTenantTimezone();
  const dates: string[] = Array.from({ length: days }, (_, i) => addDays(startDate, i, tz));

  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [dialog, setDialog] = useState<{
    workerId: string;
    workerName: string;
    from: string;
    to: string;
  } | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<{
    bar: Run;
    workerName: string;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const interactionRef = useRef<Interaction | null>(null);
  interactionRef.current = interaction;

  const cellIndexFromEvent = useCallback(
    (workerId: string, clientX: number): number | null => {
      const row = rowRefs.current[workerId];
      if (!row) return null;
      const rect = row.getBoundingClientRect();
      const x = clientX - rect.left;
      if (rect.width === 0) return null;
      return clamp(Math.floor((x / rect.width) * days), 0, days - 1);
    },
    [days],
  );

  // Global pointer move + up handlers while interacting.
  useEffect(() => {
    if (!interaction) return;

    function handleMove(e: PointerEvent) {
      const cur = interactionRef.current;
      if (!cur) return;
      const workerId = cur.kind === 'select' ? cur.workerId : cur.bar.workerId;
      const i = cellIndexFromEvent(workerId, e.clientX);
      if (i == null) return;
      if (cur.kind === 'select') {
        if (i !== cur.endIdx) setInteraction({ ...cur, endIdx: i });
        return;
      }
      if (cur.kind === 'move') {
        const offset = i - cur.grabIdx;
        const len = cur.bar.endIdx - cur.bar.startIdx;
        let s = cur.bar.startIdx + offset;
        let e2 = s + len;
        if (s < 0) {
          e2 -= s;
          s = 0;
        }
        if (e2 > days - 1) {
          s -= e2 - (days - 1);
          e2 = days - 1;
        }
        if (s !== cur.curStart || e2 !== cur.curEnd) {
          setInteraction({ ...cur, curStart: s, curEnd: e2, moved: offset !== 0 });
        }
        return;
      }
      if (cur.kind === 'resize-l') {
        const s = clamp(i, 0, cur.bar.endIdx);
        if (s !== cur.curStart) {
          setInteraction({
            ...cur,
            curStart: s,
            moved: s !== cur.bar.startIdx,
          });
        }
        return;
      }
      if (cur.kind === 'resize-r') {
        const e2 = clamp(i, cur.bar.startIdx, days - 1);
        if (e2 !== cur.curEnd) {
          setInteraction({
            ...cur,
            curEnd: e2,
            moved: e2 !== cur.bar.endIdx,
          });
        }
        return;
      }
    }

    function handleUp() {
      const cur = interactionRef.current;
      if (!cur) return;
      if (cur.kind === 'select') {
        const s = Math.min(cur.startIdx, cur.endIdx);
        const e2 = Math.max(cur.startIdx, cur.endIdx);
        const w = workers.find((x) => x.profile_id === cur.workerId);
        if (w) {
          setDialog({
            workerId: cur.workerId,
            workerName: w.display_name,
            from: dates[s],
            to: dates[e2],
          });
        }
        setInteraction(null);
        return;
      }
      const bar = cur.bar;
      if (!cur.moved) {
        const w = workers.find((x) => x.profile_id === bar.workerId);
        if (w) setRemoveConfirm({ bar, workerName: w.display_name });
        setInteraction(null);
        return;
      }
      const fromDates = rangeDates(dates, bar.startIdx, bar.endIdx);
      const toDates = rangeDates(dates, cur.curStart, cur.curEnd);
      setInteraction(null);
      startTransition(async () => {
        if (bar.type === 'sched') {
          const res = await moveAssignmentsAction({
            project_id: projectId,
            worker_profile_id: bar.workerId,
            from_dates: fromDates,
            to_dates: toDates,
          });
          if (!res.ok) toast.error(res.error ?? 'Failed to move.');
          else toast.success('Moved.');
        } else {
          if (!bar.reasonTag) return;
          const res = await moveUnavailabilityRangeAction({
            worker_profile_id: bar.workerId,
            from_dates: fromDates,
            to_dates: toDates,
            reason_tag: bar.reasonTag,
            reason_text: bar.reasonText ?? '',
          });
          if (!res.ok) toast.error(res.error);
          else toast.success('Moved.');
        }
      });
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [interaction, workers, dates, days, projectId, cellIndexFromEvent]);

  function confirmRemove() {
    if (!removeConfirm) return;
    const { bar } = removeConfirm;
    const datesToRemove = rangeDates(dates, bar.startIdx, bar.endIdx);
    setRemoveConfirm(null);
    startTransition(async () => {
      if (bar.type === 'sched') {
        const res = await deleteAssignmentsByDatesAction({
          project_id: projectId,
          worker_profile_id: bar.workerId,
          dates: datesToRemove,
        });
        if (!res.ok) toast.error(res.error ?? 'Failed to remove.');
        else toast.success('Removed.');
      } else {
        const res = await removeUnavailabilityRangeAction({
          worker_profile_id: bar.workerId,
          dates: datesToRemove,
        });
        if (!res.ok) toast.error(res.error);
        else toast.success('Removed.');
      }
    });
  }

  if (workers.length === 0) {
    return <p className="text-sm text-muted-foreground">No workers assigned yet.</p>;
  }

  const gridTemplate = { gridTemplateColumns: `160px repeat(${days}, minmax(0, 1fr))` };

  return (
    <div
      className={`select-none overflow-x-auto rounded-lg border ${isPending ? 'opacity-70' : ''}`}
    >
      <div style={gridTemplate} className="grid border-b bg-muted/40 text-xs font-medium">
        <div className="px-3 py-2">Worker</div>
        {dates.map((d) => {
          const dt = new Date(`${d}T00:00`);
          const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
          return (
            <div
              key={d}
              className={`border-l px-1 py-2 text-center ${isWeekend ? 'text-muted-foreground/70' : ''}`}
            >
              <div>
                {new Intl.DateTimeFormat('en-CA', {
                  timeZone: tz,
                  weekday: 'short',
                })
                  .format(dt)
                  .slice(0, 2)}
              </div>
              <div>{dt.getDate()}</div>
            </div>
          );
        })}
      </div>

      {workers.map((w) => {
        const perDay: ScheduleCell[] = dates.map(
          (d) => cells[`${w.profile_id}|${d}`] ?? { type: 'empty' },
        );
        const scheduledRuns = buildRunsFor(w.profile_id, dates, perDay, 'sched');
        const unavailableRuns = buildRunsFor(w.profile_id, dates, perDay, 'unav');

        const active = interaction;
        const activeWorker =
          active && (active.kind === 'select' ? active.workerId : active.bar.workerId);
        const isActiveHere = activeWorker === w.profile_id;
        let highlightStart = -1;
        let highlightEnd = -1;
        if (isActiveHere && active) {
          if (active.kind === 'select') {
            highlightStart = Math.min(active.startIdx, active.endIdx);
            highlightEnd = Math.max(active.startIdx, active.endIdx);
          } else {
            highlightStart = active.curStart;
            highlightEnd = active.curEnd;
          }
        }

        return (
          <div key={w.profile_id} style={gridTemplate} className="grid border-b last:border-0">
            <div className="whitespace-nowrap bg-background px-3 py-2 text-xs font-medium">
              {w.display_name}
            </div>
            <div
              ref={(el) => {
                rowRefs.current[w.profile_id] = el;
              }}
              style={{ gridColumn: `2 / span ${days}`, position: 'relative' }}
              className="h-14 bg-background"
            >
              <div
                className="absolute inset-0 grid"
                style={{ gridTemplateColumns: `repeat(${days}, minmax(0, 1fr))` }}
              >
                {dates.map((d, i) => {
                  const dt = new Date(`${d}T00:00`);
                  const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
                  const highlighted = isActiveHere && i >= highlightStart && i <= highlightEnd;
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`border-l transition-colors ${isWeekend ? 'bg-muted/20' : ''} ${highlighted ? 'bg-primary/20' : ''}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        setInteraction({
                          kind: 'select',
                          workerId: w.profile_id,
                          startIdx: i,
                          endIdx: i,
                        });
                      }}
                      aria-label={`Select ${d} for ${w.display_name}`}
                    />
                  );
                })}
              </div>

              {scheduledRuns.map((r) => {
                const hidden = active && active.kind !== 'select' && active.bar === r;
                const s = hidden ? active.curStart : r.startIdx;
                const e2 = hidden ? active.curEnd : r.endIdx;
                return (
                  <Bar
                    key={`s-${r.startIdx}-${r.endIdx}`}
                    run={r}
                    startIdx={s}
                    endIdx={e2}
                    totalDays={days}
                    position="top"
                    className="bg-blue-500/80 text-white"
                    label={r.label}
                    onStartMove={(grabIdx) =>
                      setInteraction({
                        kind: 'move',
                        bar: r,
                        grabIdx,
                        curStart: r.startIdx,
                        curEnd: r.endIdx,
                        moved: false,
                      })
                    }
                    onStartResize={(edge) =>
                      setInteraction({
                        kind: edge === 'l' ? 'resize-l' : 'resize-r',
                        bar: r,
                        grabIdx: edge === 'l' ? r.startIdx : r.endIdx,
                        curStart: r.startIdx,
                        curEnd: r.endIdx,
                        moved: false,
                      })
                    }
                  />
                );
              })}

              {unavailableRuns.map((r) => {
                const hidden = active && active.kind !== 'select' && active.bar === r;
                const s = hidden ? active.curStart : r.startIdx;
                const e2 = hidden ? active.curEnd : r.endIdx;
                return (
                  <Bar
                    key={`u-${r.startIdx}-${r.endIdx}`}
                    run={r}
                    startIdx={s}
                    endIdx={e2}
                    totalDays={days}
                    position="bottom"
                    className="bg-amber-500/80 text-white"
                    label={r.label}
                    onStartMove={(grabIdx) =>
                      setInteraction({
                        kind: 'move',
                        bar: r,
                        grabIdx,
                        curStart: r.startIdx,
                        curEnd: r.endIdx,
                        moved: false,
                      })
                    }
                    onStartResize={(edge) =>
                      setInteraction({
                        kind: edge === 'l' ? 'resize-l' : 'resize-r',
                        bar: r,
                        grabIdx: edge === 'l' ? r.startIdx : r.endIdx,
                        curStart: r.startIdx,
                        curEnd: r.endIdx,
                        moved: false,
                      })
                    }
                  />
                );
              })}
            </div>
          </div>
        );
      })}

      {dialog ? (
        <ScheduleWorkerDialog
          key={`${dialog.workerId}-${dialog.from}-${dialog.to}`}
          projectId={projectId}
          workerProfileId={dialog.workerId}
          workerName={dialog.workerName}
          from={dialog.from}
          to={dialog.to}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {removeConfirm ? (
        <Dialog
          open
          onOpenChange={(o) => {
            if (!o) setRemoveConfirm(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                Remove {removeConfirm.bar.type === 'sched' ? 'schedule' : 'time off'}?
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {removeConfirm.workerName} · {removeConfirm.bar.label} ·{' '}
              {dates[removeConfirm.bar.startIdx]}
              {removeConfirm.bar.endIdx !== removeConfirm.bar.startIdx
                ? ` → ${dates[removeConfirm.bar.endIdx]}`
                : ''}
            </p>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setRemoveConfirm(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={confirmRemove}>
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      <p className="border-t bg-muted/20 px-3 py-1.5 text-[11px] text-muted-foreground">
        Drag empty cells to schedule. Drag a bar to move, its edges to resize, or click to remove.
      </p>
    </div>
  );
}

function Bar({
  run: _run,
  startIdx,
  endIdx,
  totalDays,
  position,
  className,
  label,
  onStartMove,
  onStartResize,
}: {
  run: Run;
  startIdx: number;
  endIdx: number;
  totalDays: number;
  position: 'top' | 'bottom';
  className: string;
  label: string;
  onStartMove: (grabIdx: number) => void;
  onStartResize: (edge: 'l' | 'r') => void;
}) {
  const left = `calc(${(startIdx / totalDays) * 100}% + 2px)`;
  const width = `calc(${((endIdx - startIdx + 1) / totalDays) * 100}% - 4px)`;
  const vStyle = position === 'top' ? { top: 3 } : { bottom: 3 };
  return (
    <div
      className={`absolute truncate rounded px-1.5 text-[10px] font-medium ${className}`}
      style={{
        left,
        width,
        height: 24,
        lineHeight: '24px',
        cursor: 'grab',
        zIndex: 10,
        ...vStyle,
      }}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        // figure out which cell under the cursor to use as grabIdx
        const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        const x = e.clientX - rect.left;
        const idx = clamp(Math.floor((x / rect.width) * totalDays), 0, totalDays - 1);
        onStartMove(idx);
      }}
    >
      <div
        className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onStartResize('l');
        }}
      />
      <span className="pointer-events-none">{label}</span>
      <div
        className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onStartResize('r');
        }}
      />
    </div>
  );
}

const REASON_OPTIONS: { value: ReasonTag; label: string }[] = [
  { value: 'vacation', label: 'Vacation' },
  { value: 'sick', label: 'Sick' },
  { value: 'other_job', label: 'Other job' },
  { value: 'personal', label: 'Personal' },
  { value: 'other', label: 'Other' },
];

function ScheduleWorkerDialog({
  projectId,
  workerProfileId,
  workerName,
  from,
  to,
  onClose,
}: {
  projectId: string;
  workerProfileId: string;
  workerName: string;
  from: string;
  to: string;
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [type, setType] = useState<'work' | 'time_off'>('work');
  const [reasonTag, setReasonTag] = useState<ReasonTag>('vacation');

  const tz = useTenantTimezone();
  function getDates(): string[] {
    const dates: string[] = [];
    const d = new Date(`${from}T00:00`);
    const end = new Date(`${to}T00:00`);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    while (d <= end) {
      dates.push(fmt.format(d));
      d.setDate(d.getDate() + 1);
    }
    return dates;
  }

  function handleSubmit() {
    const dates = getDates();
    startTransition(async () => {
      if (type === 'work') {
        const res = await bulkAssignDatesAction({
          project_id: projectId,
          worker_profile_id: workerProfileId,
          dates,
        });
        if (!res.ok) {
          toast.error(res.error ?? 'Failed to schedule.');
          return;
        }
        toast.success('Scheduled.');
      } else {
        const res = await addUnavailabilityAction({
          worker_profile_id: workerProfileId,
          dates,
          reason_tag: reasonTag,
          reason_text: '',
        });
        if (!res.ok) {
          toast.error(res.error ?? 'Failed to mark time off.');
          return;
        }
        toast.success('Time off marked.');
      }
      onClose();
    });
  }

  const label =
    from === to
      ? new Intl.DateTimeFormat('en-CA', {
          timeZone: tz,
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }).format(new Date(`${from}T00:00`))
      : `${from} → ${to}`;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{workerName}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{label}</p>
        <div className="space-y-3">
          <Select value={type} onValueChange={(v) => setType(v as 'work' | 'time_off')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="work">Schedule for this project</SelectItem>
              <SelectItem value="time_off">Mark time off</SelectItem>
            </SelectContent>
          </Select>
          {type === 'time_off' ? (
            <Select value={reasonTag} onValueChange={(v) => setReasonTag(v as ReasonTag)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {type === 'work' ? 'Schedule' : 'Mark time off'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
