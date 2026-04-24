'use client';

/**
 * Owner-wide calendar.
 *
 * Two layouts:
 * - "month" (default): standard 7×5 calendar grid. Each cell stacks
 *   colored chips, one per (project, worker) assignment that day. Click a
 *   cell to open the assign dialog with the date prefilled.
 * - "two-week": Gantt-ish rows = projects, columns = 14 days. Each cell
 *   shows a worker chip per assignment.
 *
 * Both support a "skip weekends" toggle (default on) — when on, the
 * assign dialog excludes Sat/Sun from the date range it submits.
 *
 * TODO(extract): the per-project crew-schedule-grid.tsx covers a similar
 * surface for one project. Once this view stabilizes, evaluate extracting
 * a shared core.
 */

import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type {
  CalendarAssignment,
  CalendarProject,
  CalendarUnavailability,
  CalendarWorker,
} from '@/lib/db/queries/owner-calendar';
import { cn } from '@/lib/utils';
import {
  bulkAssignDatesAction,
  moveAssignmentToAction,
  removeAssignmentAction,
} from '@/server/actions/project-assignments';
import { AssignWorkersDialog } from './assign-workers-dialog';

type View = 'month' | 'two-week';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

// Stable project colors — pick from a small palette by hashing the id.
const PROJECT_COLORS = [
  'bg-sky-100 text-sky-900 border-sky-300',
  'bg-emerald-100 text-emerald-900 border-emerald-300',
  'bg-amber-100 text-amber-900 border-amber-300',
  'bg-violet-100 text-violet-900 border-violet-300',
  'bg-rose-100 text-rose-900 border-rose-300',
  'bg-cyan-100 text-cyan-900 border-cyan-300',
  'bg-lime-100 text-lime-900 border-lime-300',
  'bg-fuchsia-100 text-fuchsia-900 border-fuchsia-300',
  'bg-orange-100 text-orange-900 border-orange-300',
  'bg-teal-100 text-teal-900 border-teal-300',
];

function projectColor(projectId: string): string {
  let hash = 0;
  for (let i = 0; i < projectId.length; i++) hash = (hash * 31 + projectId.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}

function isoDate(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function parseIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function isWeekend(iso: string): boolean {
  const day = parseIso(iso).getDay();
  return day === 0 || day === 6;
}

function isToday(iso: string): boolean {
  return iso === isoDate(new Date());
}

type DialogState =
  | { open: false }
  | { open: true; projectId: string | null; startDate: string; endDate: string };

export function OwnerCalendar({
  view,
  anchorDate,
  windowStart,
  windowEnd,
  projects,
  workers,
  assignments,
  unavailability,
}: {
  view: View;
  anchorDate: string;
  windowStart: string;
  windowEnd: string;
  projects: CalendarProject[];
  workers: CalendarWorker[];
  assignments: CalendarAssignment[];
  unavailability: CalendarUnavailability[];
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [dialog, setDialog] = useState<DialogState>({ open: false });
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const workerById = useMemo(() => new Map(workers.map((w) => [w.profile_id, w])), [workers]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  // Group assignments by date for fast cell lookup.
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarAssignment[]>();
    for (const a of assignments) {
      const arr = map.get(a.scheduled_date) ?? [];
      arr.push(a);
      map.set(a.scheduled_date, arr);
    }
    return map;
  }, [assignments]);

  // For two-week view: only show projects that are active OR have any
  // assignment in the window. Avoids rendering 50 dormant projects.
  // Sort by status (in_progress > planning > complete > cancelled), then name.
  const visibleProjects = useMemo(() => {
    const withAssignments = new Set(assignments.map((a) => a.project_id));
    const stageRank: Record<string, number> = {
      active: 0,
      awaiting_approval: 1,
      planning: 2,
      on_hold: 3,
      complete: 4,
      declined: 5,
      cancelled: 6,
    };
    return projects
      .filter(
        (p) =>
          p.lifecycle_stage !== 'cancelled' &&
          p.lifecycle_stage !== 'declined' &&
          (p.lifecycle_stage !== 'complete' || withAssignments.has(p.id)),
      )
      .sort(
        (a, b) =>
          (stageRank[a.lifecycle_stage] ?? 99) - (stageRank[b.lifecycle_stage] ?? 99) ||
          a.name.localeCompare(b.name),
      );
  }, [projects, assignments]);

  const anchor = parseIso(anchorDate);

  function navigate(deltaMonths: number, deltaDays: number) {
    const d = new Date(anchor);
    d.setMonth(d.getMonth() + deltaMonths);
    d.setDate(d.getDate() + deltaDays);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const params = new URLSearchParams(sp);
    params.set('ym', ym);
    if (view === 'two-week') {
      // Two-week view also tracks the day inside the month — store as ?ym=YYYY-MM
      // and we'll read ?day too if present.
      params.set('ym', d.toISOString().slice(0, 10));
    }
    router.push(`/calendar?${params.toString()}`);
  }

  function setView(next: View) {
    const params = new URLSearchParams(sp);
    if (next === 'month') params.delete('view');
    else params.set('view', 'two-week');
    router.push(`/calendar?${params.toString()}`);
  }

  function jumpToToday() {
    const params = new URLSearchParams(sp);
    params.delete('ym');
    router.push(`/calendar?${params.toString()}`);
  }

  function openAssign(startDate: string, endDate: string, projectId: string | null) {
    const lo = startDate <= endDate ? startDate : endDate;
    const hi = startDate <= endDate ? endDate : startDate;
    setDialog({ open: true, projectId, startDate: lo, endDate: hi });
  }

  function handleRemove(assignmentId: string) {
    startTransition(async () => {
      const res = await removeAssignmentAction(assignmentId);
      if (!res.ok) toast.error(res.error ?? 'Failed to remove.');
      else toast.success('Removed.');
    });
  }

  function handleMove(input: {
    assignmentId: string;
    fromProjectId: string;
    toProjectId: string;
    fromDate: string;
    toDate: string;
  }) {
    if (input.fromProjectId === input.toProjectId && input.fromDate === input.toDate) return;
    startTransition(async () => {
      const res = await moveAssignmentToAction({
        assignment_id: input.assignmentId,
        target_project_id: input.toProjectId,
        target_date: input.toDate,
      });
      if (!res.ok) toast.error(res.error ?? 'Failed to move.');
      else toast.success('Moved.');
    });
  }

  function handleExtend(input: {
    projectId: string;
    workerProfileId: string;
    fromDate: string;
    throughDate: string;
  }) {
    // "Extend" = duplicate the chip across the swept date range. We bulk-assign
    // every business day between fromDate (exclusive) and throughDate (inclusive),
    // honoring the skip-weekends toggle.
    const lo = input.fromDate < input.throughDate ? input.fromDate : input.throughDate;
    const hi = input.fromDate < input.throughDate ? input.throughDate : input.fromDate;
    const dates: string[] = [];
    for (let d = parseIso(lo); isoDate(d) <= hi; d.setDate(d.getDate() + 1)) {
      const iso = isoDate(d);
      if (iso === input.fromDate) continue; // source already booked
      const day = d.getDay();
      if (skipWeekends && (day === 0 || day === 6)) continue;
      dates.push(iso);
    }
    if (dates.length === 0) return;

    startTransition(async () => {
      const res = await bulkAssignDatesAction({
        project_id: input.projectId,
        worker_profile_id: input.workerProfileId,
        dates,
      });
      if (!res.ok) toast.error(res.error ?? 'Failed to extend.');
      else toast.success(`Added ${dates.length} day${dates.length === 1 ? '' : 's'}.`);
    });
  }

  const headerLabel =
    view === 'two-week'
      ? `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getDate()}, ${anchor.getFullYear()}`
      : `${MONTH_NAMES[anchor.getMonth()]} ${anchor.getFullYear()}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(view === 'month' ? -1 : 0, view === 'two-week' ? -14 : 0)}
            aria-label="Previous"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="min-w-[180px] text-center font-medium">{headerLabel}</div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(view === 'month' ? 1 : 0, view === 'two-week' ? 14 : 0)}
            aria-label="Next"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={jumpToToday}>
            Today
          </Button>
        </div>

        <div className="flex items-center gap-4">
          <label htmlFor="skip-weekends" className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              id="skip-weekends"
              checked={skipWeekends}
              onCheckedChange={(v) => setSkipWeekends(v === true)}
            />
            <span className="text-muted-foreground">Skip weekends</span>
          </label>

          <div className="inline-flex rounded-md border bg-background p-0.5">
            <button
              type="button"
              onClick={() => setView('month')}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition',
                view === 'month' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              Month
            </button>
            <button
              type="button"
              onClick={() => setView('two-week')}
              className={cn(
                'rounded px-3 py-1 text-xs font-medium transition',
                view === 'two-week'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground',
              )}
            >
              2 weeks
            </button>
          </div>
        </div>
      </div>

      {/* Desktop grids */}
      <div className={cn('hidden sm:block', pending && 'pointer-events-none opacity-70')}>
        {view === 'month' ? (
          <MonthGrid
            windowStart={windowStart}
            windowEnd={windowEnd}
            anchorMonth={anchor.getMonth()}
            byDate={byDate}
            projectById={projectById}
            workerById={workerById}
            onOpenAssign={(date) => openAssign(date, date, null)}
            onSelectChip={(a) => setActiveChip(a.id)}
            activeChipId={activeChip}
          />
        ) : (
          <TwoWeekGrid
            windowStart={windowStart}
            byDate={byDate}
            projects={visibleProjects}
            workerById={workerById}
            onOpenAssign={(projectId, startDate, endDate) =>
              openAssign(startDate, endDate, projectId)
            }
            onMove={handleMove}
            onExtend={handleExtend}
            onSelectChip={(a) => setActiveChip(a.id)}
            activeChipId={activeChip}
          />
        )}
      </div>

      {/* Mobile stacked day list */}
      <div className={cn('sm:hidden', pending && 'pointer-events-none opacity-70')}>
        <MobileDayList
          view={view}
          windowStart={windowStart}
          windowEnd={windowEnd}
          anchorMonth={anchor.getMonth()}
          byDate={byDate}
          projectById={projectById}
          workerById={workerById}
          onOpenAssign={(date) => openAssign(date, date, null)}
          onRemove={handleRemove}
        />
      </div>

      {/* Chip popover (action sheet for the focused chip). */}
      {activeChip
        ? (() => {
            const a = assignments.find((x) => x.id === activeChip);
            if (!a) return null;
            const proj = projectById.get(a.project_id);
            const w = workerById.get(a.worker_profile_id);
            return (
              <ChipActionSheet
                projectName={proj?.name ?? 'Project'}
                projectId={a.project_id}
                workerName={w?.display_name ?? 'Worker'}
                date={a.scheduled_date}
                onClose={() => setActiveChip(null)}
                onRemove={() => {
                  handleRemove(a.id);
                  setActiveChip(null);
                }}
                pending={pending}
              />
            );
          })()
        : null}

      {dialog.open ? (
        <AssignWorkersDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog({ open: false });
          }}
          projects={projects.filter(
            (p) =>
              p.lifecycle_stage !== 'cancelled' &&
              p.lifecycle_stage !== 'complete' &&
              p.lifecycle_stage !== 'declined',
          )}
          workers={workers}
          assignments={assignments}
          unavailability={unavailability}
          initialProjectId={dialog.projectId}
          initialStartDate={dialog.startDate}
          initialEndDate={dialog.endDate}
          skipWeekends={skipWeekends}
        />
      ) : null}
    </div>
  );
}

// ----------------------------------------------------------------------
// Month grid (standard 7×N calendar)
// ----------------------------------------------------------------------

function MonthGrid({
  windowStart,
  windowEnd,
  anchorMonth,
  byDate,
  projectById,
  workerById,
  onOpenAssign,
  onSelectChip,
  activeChipId,
}: {
  windowStart: string;
  windowEnd: string;
  anchorMonth: number;
  byDate: Map<string, CalendarAssignment[]>;
  projectById: Map<string, CalendarProject>;
  workerById: Map<string, CalendarWorker>;
  onOpenAssign: (date: string) => void;
  onSelectChip: (assignment: CalendarAssignment) => void;
  activeChipId: string | null;
}) {
  const days: string[] = [];
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push(isoDate(d));
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="grid grid-cols-7 border-b bg-muted/40 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {DAY_NAMES.map((n) => (
          <div key={n} className="px-2 py-2">
            {n}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((iso) => {
          const date = parseIso(iso);
          const inMonth = date.getMonth() === anchorMonth;
          const items = byDate.get(iso) ?? [];
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onOpenAssign(iso)}
              aria-label={`Schedule on ${iso}`}
              className={cn(
                'group/cell min-h-[110px] cursor-pointer border-b border-r p-1.5 text-left transition hover:bg-muted/40 last:border-r-0',
                !inMonth && 'bg-muted/20',
                isWeekend(iso) && 'bg-muted/10',
              )}
            >
              <div
                className={cn(
                  'mb-1 flex h-6 w-6 items-center justify-center rounded text-xs font-medium',
                  isToday(iso) && 'bg-primary text-primary-foreground',
                  !inMonth && 'text-muted-foreground/60',
                )}
              >
                {date.getDate()}
              </div>
              <div className="space-y-0.5">
                {items.map((a) => {
                  const proj = projectById.get(a.project_id);
                  const w = workerById.get(a.worker_profile_id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectChip(a);
                      }}
                      title={`${proj?.name ?? 'Project'} · ${w?.display_name ?? 'Worker'}`}
                      className={cn(
                        'flex w-full items-center gap-1 rounded border px-1.5 py-0.5 text-left text-[11px] leading-tight transition hover:brightness-95',
                        projectColor(a.project_id),
                        activeChipId === a.id && 'ring-2 ring-foreground ring-offset-1',
                      )}
                    >
                      <span className="truncate">{w?.display_name ?? '?'}</span>
                    </button>
                  );
                })}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------
// Two-week grid (project rows × 14 days)
// ----------------------------------------------------------------------

type DragState = {
  projectId: string;
  startIdx: number;
  endIdx: number;
};

type ChipDrag = {
  assignmentId: string;
  fromProjectId: string;
  workerProfileId: string;
  fromDate: string;
};

type Bar = {
  workerProfileId: string;
  workerName: string;
  startIdx: number;
  length: number;
  assignmentIds: string[];
  startDate: string;
  endDate: string;
  lane: number;
};

/** Group consecutive same-worker chips into spanning bars; assign vertical lanes. */
function computeBars(
  projectId: string,
  days: string[],
  byDate: Map<string, CalendarAssignment[]>,
  workerById: Map<string, CalendarWorker>,
): Bar[] {
  // Collect all assignments for this project within the window, grouped by worker.
  const byWorker = new Map<string, { idx: number; iso: string; assignmentId: string }[]>();
  days.forEach((iso, idx) => {
    for (const a of byDate.get(iso) ?? []) {
      if (a.project_id !== projectId) continue;
      const arr = byWorker.get(a.worker_profile_id) ?? [];
      arr.push({ idx, iso, assignmentId: a.id });
      byWorker.set(a.worker_profile_id, arr);
    }
  });

  const raw: Omit<Bar, 'lane'>[] = [];
  for (const [workerProfileId, items] of byWorker) {
    items.sort((a, b) => a.idx - b.idx);
    let runStart = items[0];
    let runIds: string[] = [items[0].assignmentId];
    let lastIdx = items[0].idx;
    for (let i = 1; i < items.length; i++) {
      if (items[i].idx === lastIdx + 1) {
        runIds.push(items[i].assignmentId);
        lastIdx = items[i].idx;
      } else {
        raw.push({
          workerProfileId,
          workerName: workerById.get(workerProfileId)?.display_name ?? '?',
          startIdx: runStart.idx,
          length: lastIdx - runStart.idx + 1,
          assignmentIds: runIds,
          startDate: runStart.iso,
          endDate: days[lastIdx],
        });
        runStart = items[i];
        runIds = [items[i].assignmentId];
        lastIdx = items[i].idx;
      }
    }
    raw.push({
      workerProfileId,
      workerName: workerById.get(workerProfileId)?.display_name ?? '?',
      startIdx: runStart.idx,
      length: lastIdx - runStart.idx + 1,
      assignmentIds: runIds,
      startDate: runStart.iso,
      endDate: days[lastIdx],
    });
  }

  // Greedy lane assignment so overlapping bars stack vertically.
  raw.sort((a, b) => a.startIdx - b.startIdx);
  const laneEnds: number[] = []; // for each lane, the rightmost endIdx so far
  return raw.map((b) => {
    const endIdx = b.startIdx + b.length - 1;
    let lane = laneEnds.findIndex((e) => e < b.startIdx);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(endIdx);
    } else {
      laneEnds[lane] = endIdx;
    }
    return { ...b, lane };
  });
}

function TwoWeekGrid({
  windowStart,
  byDate,
  projects,
  workerById,
  onOpenAssign,
  onMove,
  onExtend,
  onSelectChip,
  activeChipId,
}: {
  windowStart: string;
  byDate: Map<string, CalendarAssignment[]>;
  projects: CalendarProject[];
  workerById: Map<string, CalendarWorker>;
  onOpenAssign: (projectId: string, startDate: string, endDate: string) => void;
  onMove: (input: ChipDrag & { toProjectId: string; toDate: string }) => void;
  onExtend: (input: {
    projectId: string;
    workerProfileId: string;
    fromDate: string;
    throughDate: string;
  }) => void;
  onSelectChip: (assignment: CalendarAssignment) => void;
  activeChipId: string | null;
}) {
  const days: string[] = [];
  const start = parseIso(windowStart);
  for (let i = 0; i < 14; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    days.push(isoDate(d));
  }

  // Pre-compute assignments per (project, date) for the visible window.
  const cellLookup = new Map<string, CalendarAssignment[]>();
  for (const iso of days) {
    for (const a of byDate.get(iso) ?? []) {
      const k = `${a.project_id}|${iso}`;
      const arr = cellLookup.get(k) ?? [];
      arr.push(a);
      cellLookup.set(k, arr);
    }
  }

  const [drag, setDrag] = useState<DragState | null>(null);
  const [chipDrag, setChipDrag] = useState<ChipDrag | null>(null);
  const [extend, setExtend] = useState<{
    assignmentId: string;
    projectId: string;
    workerProfileId: string;
    fromDate: string;
    throughIdx: number;
  } | null>(null);

  // Document-level mouseup completes whichever drag is active.
  // biome-ignore lint/correctness/useExhaustiveDependencies: days re-renders each frame; only re-bind on drag/extend change
  useEffect(() => {
    if (!drag && !extend) return;
    const handleUp = () => {
      if (drag) {
        const lo = Math.min(drag.startIdx, drag.endIdx);
        const hi = Math.max(drag.startIdx, drag.endIdx);
        onOpenAssign(drag.projectId, days[lo], days[hi]);
        setDrag(null);
      }
      if (extend) {
        onExtend({
          projectId: extend.projectId,
          workerProfileId: extend.workerProfileId,
          fromDate: extend.fromDate,
          throughDate: days[extend.throughIdx],
        });
        setExtend(null);
      }
    };
    document.addEventListener('mouseup', handleUp);
    return () => document.removeEventListener('mouseup', handleUp);
  }, [drag, extend]);

  // Auto-scroll horizontally so today is visible on first render of this view.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run when the visible window shifts
  useEffect(() => {
    if (!scrollerRef.current) return;
    const todayIdx = days.findIndex(isToday);
    if (todayIdx < 0) return;
    const cellWidth = scrollerRef.current.scrollWidth / (days.length + 200 / 70);
    scrollerRef.current.scrollLeft = Math.max(0, cellWidth * todayIdx - cellWidth * 2);
  }, [windowStart]);

  return (
    <div ref={scrollerRef} className="overflow-x-auto rounded-lg border bg-background">
      <div className="grid min-w-[1100px] select-none" style={{ gridTemplateColumns: `200px 1fr` }}>
        {/* Header */}
        <div className="border-b border-r bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Project
        </div>
        <div
          className="grid border-b bg-muted/40"
          style={{ gridTemplateColumns: `repeat(14, minmax(70px, 1fr))` }}
        >
          {days.map((iso) => {
            const d = parseIso(iso);
            return (
              <div
                key={iso}
                className={cn(
                  'border-r px-1 py-2 text-center text-xs font-medium last:border-r-0',
                  isWeekend(iso) ? 'bg-muted/30 text-muted-foreground' : '',
                  isToday(iso) && 'bg-primary/10 text-primary',
                )}
              >
                <div>{DAY_NAMES[d.getDay()]}</div>
                <div className="text-[10px]">{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        {/* Rows */}
        {projects.length === 0 ? (
          <div className="col-span-full p-8 text-center text-sm text-muted-foreground">
            No projects in this window.
          </div>
        ) : (
          projects.map((p) => {
            const bars = computeBars(p.id, days, byDate, workerById);
            const lanes = bars.length === 0 ? 1 : Math.max(...bars.map((b) => b.lane)) + 1;
            return (
              <ProjectRow
                key={p.id}
                project={p}
                days={days}
                bars={bars}
                lanes={lanes}
                cellLookup={cellLookup}
                drag={drag}
                chipDrag={chipDrag}
                extend={extend && extend.projectId === p.id ? extend : null}
                activeChipId={activeChipId}
                onCellMouseDown={(idx) => setDrag({ projectId: p.id, startIdx: idx, endIdx: idx })}
                onCellMouseEnter={(idx) => {
                  setDrag((cur) => (cur && cur.projectId === p.id ? { ...cur, endIdx: idx } : cur));
                  setExtend((cur) =>
                    cur && cur.projectId === p.id ? { ...cur, throughIdx: idx } : cur,
                  );
                }}
                onChipDragStart={setChipDrag}
                onChipDragEnd={() => setChipDrag(null)}
                onChipDrop={(toDate) => {
                  if (chipDrag) onMove({ ...chipDrag, toProjectId: p.id, toDate });
                  setChipDrag(null);
                }}
                onExtendStart={(bar) => {
                  // Anchor extend on the LAST day of the bar so dragging right
                  // adds new days; the extend handler treats `fromDate` as the
                  // existing-source-date and adds days between fromDate and
                  // throughDate.
                  setExtend({
                    assignmentId: bar.assignmentIds[bar.assignmentIds.length - 1],
                    projectId: p.id,
                    workerProfileId: bar.workerProfileId,
                    fromDate: bar.endDate,
                    throughIdx: bar.startIdx + bar.length - 1,
                  });
                }}
                onSelectBar={(bar) =>
                  onSelectChip({
                    // Use leftmost assignment as the "anchor" for the action sheet.
                    id: bar.assignmentIds[0],
                    project_id: p.id,
                    worker_profile_id: bar.workerProfileId,
                    scheduled_date: bar.startDate,
                  })
                }
              />
            );
          })
        )}
      </div>
      <p className="border-t bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
        Click cells to schedule, drag across empty cells to schedule a range, drag a chip to move
        it, or grab a chip's right edge to extend it across days.
      </p>
    </div>
  );
}

type ExtendState = {
  assignmentId: string;
  projectId: string;
  workerProfileId: string;
  fromDate: string;
  throughIdx: number;
};

function ProjectRow({
  project,
  days,
  bars,
  lanes,
  cellLookup: _cellLookup,
  drag,
  chipDrag,
  extend,
  activeChipId,
  onCellMouseDown,
  onCellMouseEnter,
  onChipDragStart,
  onChipDragEnd,
  onChipDrop,
  onExtendStart,
  onSelectBar,
}: {
  project: CalendarProject;
  days: string[];
  bars: Bar[];
  lanes: number;
  cellLookup: Map<string, CalendarAssignment[]>;
  drag: DragState | null;
  chipDrag: ChipDrag | null;
  extend: ExtendState | null;
  activeChipId: string | null;
  onCellMouseDown: (idx: number) => void;
  onCellMouseEnter: (idx: number) => void;
  onChipDragStart: (drag: ChipDrag) => void;
  onChipDragEnd: () => void;
  onChipDrop: (toDate: string) => void;
  onExtendStart: (bar: Bar) => void;
  onSelectBar: (bar: Bar) => void;
}) {
  const color = projectColor(project.id);
  const dragLo = drag && drag.projectId === project.id ? Math.min(drag.startIdx, drag.endIdx) : -1;
  const dragHi = drag && drag.projectId === project.id ? Math.max(drag.startIdx, drag.endIdx) : -1;

  const extendLo =
    extend && days.indexOf(extend.fromDate) >= 0
      ? Math.min(days.indexOf(extend.fromDate), extend.throughIdx)
      : -1;
  const extendHi =
    extend && days.indexOf(extend.fromDate) >= 0
      ? Math.max(days.indexOf(extend.fromDate), extend.throughIdx)
      : -1;

  // Each lane is 22px tall + 4px gap; minimum row height accommodates lanes plus padding.
  const rowMinHeight = Math.max(60, lanes * 26 + 14);

  return (
    <>
      {/* Project label (col 1 of the outer 200px+1fr grid) */}
      <button
        type="button"
        onClick={() => onCellMouseDown(0)}
        onMouseDown={(e) => {
          e.preventDefault();
          onCellMouseDown(0);
          requestAnimationFrame(() =>
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })),
          );
        }}
        style={{ minHeight: `${rowMinHeight}px` }}
        className="flex flex-col justify-center border-b border-r px-3 py-2 text-left transition hover:bg-muted/40"
        title={`Schedule on ${project.name}`}
      >
        <div className="truncate text-sm font-medium">{project.name}</div>
        {project.customer_name ? (
          <div className="truncate text-xs text-muted-foreground">{project.customer_name}</div>
        ) : null}
      </button>

      {/* Right side: own 14-col grid where cells span the full height and bars sit in lanes */}
      <div
        className="grid border-b"
        style={{
          gridTemplateColumns: `repeat(14, minmax(70px, 1fr))`,
          minHeight: `${rowMinHeight}px`,
        }}
      >
        {/* Drop-target cells (each in its column, spanning all sub-rows) */}
        {days.map((iso, idx) => {
          const inDrag = idx >= dragLo && idx <= dragHi;
          const inExtend = extend ? idx >= extendLo && idx <= extendHi : false;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: drop target wraps interactive children
            <div
              key={iso}
              style={{ gridColumn: idx + 1, gridRow: '1 / -1' }}
              onMouseDown={(e) => {
                const target = e.target as HTMLElement;
                if (target.closest('button')) return;
                if (target.closest('[data-chip="1"]')) return;
                if (target.closest('[data-extend-handle="1"]')) return;
                e.preventDefault();
                onCellMouseDown(idx);
              }}
              onMouseEnter={() => onCellMouseEnter(idx)}
              onDragOver={(e) => {
                if (chipDrag) {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                }
              }}
              onDrop={(e) => {
                if (!chipDrag) return;
                e.preventDefault();
                onChipDrop(iso);
              }}
              className={cn(
                'cursor-pointer border-r transition hover:bg-muted/40 last:border-r-0',
                isWeekend(iso) && 'bg-muted/10',
                isToday(iso) && 'ring-1 ring-inset ring-primary/40',
                inDrag && 'bg-primary/15 ring-1 ring-inset ring-primary/60',
                inExtend && 'bg-emerald-100/50',
                chipDrag && 'bg-primary/5',
              )}
            />
          );
        })}

        {/* Spanning bars in their lanes (rows 2+, on top via z-index) */}
        {bars.map((bar) => {
          const isBeingDragged = chipDrag && bar.assignmentIds.includes(chipDrag.assignmentId);
          const isActive = activeChipId !== null && bar.assignmentIds.includes(activeChipId);
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source; click also present
            // biome-ignore lint/a11y/useKeyWithClickEvents: action sheet on tap is the keyboard alt
            <div
              key={`${bar.workerProfileId}-${bar.startIdx}`}
              data-chip="1"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', bar.assignmentIds[0]);
                onChipDragStart({
                  assignmentId: bar.assignmentIds[0],
                  fromProjectId: project.id,
                  workerProfileId: bar.workerProfileId,
                  fromDate: bar.startDate,
                });
              }}
              onDragEnd={onChipDragEnd}
              onClick={(e) => {
                e.stopPropagation();
                onSelectBar(bar);
              }}
              title={`${bar.workerName} — ${bar.length === 1 ? bar.startDate : `${bar.startDate} → ${bar.endDate}`}`}
              style={{
                gridColumn: `${bar.startIdx + 1} / span ${bar.length}`,
                gridRow: bar.lane + 2,
                marginTop: '4px',
                marginBottom: '2px',
                marginLeft: '2px',
                marginRight: '2px',
                height: '22px',
                zIndex: 5,
              }}
              className={cn(
                'group/chip relative flex cursor-grab items-center overflow-hidden rounded border pl-1.5 pr-2 text-[11px] leading-tight active:cursor-grabbing',
                color,
                isBeingDragged && 'opacity-40',
                isActive && 'ring-2 ring-foreground ring-offset-1',
              )}
            >
              <span className="flex-1 truncate font-medium">{bar.workerName}</span>
              {bar.length > 1 ? (
                <span className="ml-1 shrink-0 rounded bg-foreground/10 px-1 text-[10px]">
                  {bar.length}d
                </span>
              ) : null}
              {/* Right-edge extend handle */}
              <span
                data-extend-handle="1"
                aria-hidden="true"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onExtendStart(bar);
                }}
                className="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize opacity-0 transition hover:bg-foreground/40 group-hover/chip:opacity-60"
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

// ----------------------------------------------------------------------
// Mobile: stacked day list (replaces grid below sm:)
// ----------------------------------------------------------------------

function MobileDayList({
  view,
  windowStart,
  windowEnd,
  anchorMonth,
  byDate,
  projectById,
  workerById,
  onOpenAssign,
  onRemove,
}: {
  view: View;
  windowStart: string;
  windowEnd: string;
  anchorMonth: number;
  byDate: Map<string, CalendarAssignment[]>;
  projectById: Map<string, CalendarProject>;
  workerById: Map<string, CalendarWorker>;
  onOpenAssign: (date: string) => void;
  onRemove: (assignmentId: string) => void;
}) {
  const days: string[] = [];
  const start = parseIso(windowStart);
  const end = parseIso(windowEnd);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = isoDate(d);
    // For month view, only show days in the anchor month (not the leading/trailing pad days).
    if (view === 'month' && parseIso(iso).getMonth() !== anchorMonth) continue;
    days.push(iso);
  }

  return (
    <div className="space-y-2">
      {days.map((iso) => {
        const date = parseIso(iso);
        const items = byDate.get(iso) ?? [];
        return (
          <div
            key={iso}
            className={cn(
              'rounded-lg border bg-background',
              isToday(iso) && 'border-primary/40 bg-primary/5',
              isWeekend(iso) && 'bg-muted/20',
            )}
          >
            <button
              type="button"
              onClick={() => onOpenAssign(iso)}
              className="flex w-full items-center justify-between px-3 py-2 text-left"
            >
              <div className="text-sm font-medium">
                {date.toLocaleDateString('en-CA', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
                {isToday(iso) && (
                  <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-primary-foreground">
                    Today
                  </span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {items.length === 0 ? 'Tap to schedule' : `${items.length} booked · tap to add`}
              </span>
            </button>
            {items.length > 0 ? (
              <div className="space-y-1 border-t px-3 py-2">
                {items.map((a) => {
                  const proj = projectById.get(a.project_id);
                  const w = workerById.get(a.worker_profile_id);
                  return (
                    <div
                      key={a.id}
                      className={cn(
                        'flex items-center gap-2 rounded border px-2 py-1.5 text-xs',
                        projectColor(a.project_id),
                      )}
                    >
                      <div className="flex-1 truncate">
                        <div className="font-medium">{w?.display_name ?? 'Worker'}</div>
                        <div className="truncate text-[11px] opacity-75">
                          {proj?.name ?? 'Project'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onRemove(a.id)}
                        className="rounded p-1 hover:bg-foreground/10"
                        aria-label="Remove assignment"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ----------------------------------------------------------------------
// Chip action sheet (popover-ish detail panel for a focused chip)
// ----------------------------------------------------------------------

function ChipActionSheet({
  projectName,
  projectId,
  workerName,
  date,
  onClose,
  onRemove,
  pending,
}: {
  projectName: string;
  projectId: string;
  workerName: string;
  date: string;
  onClose: () => void;
  onRemove: () => void;
  pending: boolean;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{workerName}</DialogTitle>
          <DialogDescription>
            {projectName} ·{' '}
            {parseIso(date).toLocaleDateString('en-CA', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <Link href={`/projects/${projectId}`} className="w-full sm:w-auto">
            <Button type="button" variant="outline" className="w-full">
              Open project
            </Button>
          </Link>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onRemove}
            className="w-full sm:w-auto"
          >
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
