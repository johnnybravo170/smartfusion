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
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type {
  CalendarAssignment,
  CalendarProject,
  CalendarWorker,
} from '@/lib/db/queries/owner-calendar';
import { cn } from '@/lib/utils';
import {
  moveAssignmentsAction,
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
}: {
  view: View;
  anchorDate: string;
  windowStart: string;
  windowEnd: string;
  projects: CalendarProject[];
  workers: CalendarWorker[];
  assignments: CalendarAssignment[];
}) {
  const router = useRouter();
  const sp = useSearchParams();
  const [skipWeekends, setSkipWeekends] = useState(true);
  const [dialog, setDialog] = useState<DialogState>({ open: false });
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
  const visibleProjects = useMemo(() => {
    const withAssignments = new Set(assignments.map((a) => a.project_id));
    return projects
      .filter(
        (p) => p.status !== 'cancelled' && (p.status !== 'complete' || withAssignments.has(p.id)),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
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
    projectId: string;
    workerProfileId: string;
    fromDate: string;
    toDate: string;
  }) {
    if (input.fromDate === input.toDate) return;
    startTransition(async () => {
      const res = await moveAssignmentsAction({
        project_id: input.projectId,
        worker_profile_id: input.workerProfileId,
        from_dates: [input.fromDate],
        to_dates: [input.toDate],
      });
      if (!res.ok) toast.error(res.error ?? 'Failed to move.');
      else toast.success('Moved.');
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

      {view === 'month' ? (
        <MonthGrid
          windowStart={windowStart}
          windowEnd={windowEnd}
          anchorMonth={anchor.getMonth()}
          byDate={byDate}
          projectById={projectById}
          workerById={workerById}
          onOpenAssign={(date) => openAssign(date, date, null)}
          onRemove={handleRemove}
          pending={pending}
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
          onRemove={handleRemove}
          onMove={handleMove}
          pending={pending}
        />
      )}

      {dialog.open ? (
        <AssignWorkersDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog({ open: false });
          }}
          projects={projects.filter((p) => p.status !== 'cancelled' && p.status !== 'complete')}
          workers={workers}
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
  onRemove,
  pending,
}: {
  windowStart: string;
  windowEnd: string;
  anchorMonth: number;
  byDate: Map<string, CalendarAssignment[]>;
  projectById: Map<string, CalendarProject>;
  workerById: Map<string, CalendarWorker>;
  onOpenAssign: (date: string) => void;
  onRemove: (assignmentId: string) => void;
  pending: boolean;
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
                    <div
                      key={a.id}
                      title={`${proj?.name ?? 'Project'} · ${w?.display_name ?? 'Worker'}`}
                      className={cn(
                        'group/chip flex items-center justify-between gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-tight',
                        projectColor(a.project_id),
                      )}
                    >
                      <span className="truncate">{w?.display_name ?? '?'}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemove(a.id);
                        }}
                        disabled={pending}
                        className="opacity-0 transition group-hover/chip:opacity-100"
                        aria-label="Remove assignment"
                      >
                        <X className="size-2.5" />
                      </button>
                    </div>
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
  projectId: string;
  workerProfileId: string;
  fromDate: string;
};

function TwoWeekGrid({
  windowStart,
  byDate,
  projects,
  workerById,
  onOpenAssign,
  onRemove,
  onMove,
  pending,
}: {
  windowStart: string;
  byDate: Map<string, CalendarAssignment[]>;
  projects: CalendarProject[];
  workerById: Map<string, CalendarWorker>;
  onOpenAssign: (projectId: string, startDate: string, endDate: string) => void;
  onRemove: (assignmentId: string) => void;
  onMove: (input: ChipDrag & { toDate: string }) => void;
  pending: boolean;
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

  // Document-level mouseup so the drag completes even if released outside a cell.
  // biome-ignore lint/correctness/useExhaustiveDependencies: days/onOpenAssign re-render each frame; only re-bind on drag start
  useEffect(() => {
    if (!drag) return;
    const handleUp = () => {
      const lo = Math.min(drag.startIdx, drag.endIdx);
      const hi = Math.max(drag.startIdx, drag.endIdx);
      onOpenAssign(drag.projectId, days[lo], days[hi]);
      setDrag(null);
    };
    document.addEventListener('mouseup', handleUp);
    return () => document.removeEventListener('mouseup', handleUp);
  }, [drag]);

  return (
    <div className="overflow-x-auto rounded-lg border bg-background">
      <div
        className="grid min-w-[1100px] select-none"
        style={{ gridTemplateColumns: `200px repeat(14, minmax(70px, 1fr))` }}
      >
        {/* Header */}
        <div className="border-b border-r bg-muted/40 px-3 py-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Project
        </div>
        {days.map((iso) => {
          const d = parseIso(iso);
          return (
            <div
              key={iso}
              className={cn(
                'border-b border-r px-1 py-2 text-center text-xs font-medium last:border-r-0',
                isWeekend(iso) ? 'bg-muted/30 text-muted-foreground' : 'bg-muted/40',
                isToday(iso) && 'bg-primary/10 text-primary',
              )}
            >
              <div>{DAY_NAMES[d.getDay()]}</div>
              <div className="text-[10px]">{d.getDate()}</div>
            </div>
          );
        })}

        {/* Rows */}
        {projects.length === 0 ? (
          <div className="col-span-full p-8 text-center text-sm text-muted-foreground">
            No projects in this window.
          </div>
        ) : (
          projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              days={days}
              cellLookup={cellLookup}
              workerById={workerById}
              drag={drag}
              chipDrag={chipDrag}
              onCellMouseDown={(idx) => setDrag({ projectId: p.id, startIdx: idx, endIdx: idx })}
              onCellMouseEnter={(idx) =>
                setDrag((cur) => (cur && cur.projectId === p.id ? { ...cur, endIdx: idx } : cur))
              }
              onChipDragStart={setChipDrag}
              onChipDragEnd={() => setChipDrag(null)}
              onChipDrop={(toDate) => {
                if (chipDrag && chipDrag.projectId === p.id) {
                  onMove({ ...chipDrag, toDate });
                } else if (chipDrag) {
                  toast.error('Cross-project moves not supported yet — remove and re-add.');
                }
                setChipDrag(null);
              }}
              onRemove={onRemove}
              pending={pending}
            />
          ))
        )}
      </div>
      <p className="border-t bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
        Click or drag across empty cells to schedule. Drag a worker chip to a new day to move it.
      </p>
    </div>
  );
}

function ProjectRow({
  project,
  days,
  cellLookup,
  workerById,
  drag,
  chipDrag,
  onCellMouseDown,
  onCellMouseEnter,
  onChipDragStart,
  onChipDragEnd,
  onChipDrop,
  onRemove,
  pending,
}: {
  project: CalendarProject;
  days: string[];
  cellLookup: Map<string, CalendarAssignment[]>;
  workerById: Map<string, CalendarWorker>;
  drag: DragState | null;
  chipDrag: ChipDrag | null;
  onCellMouseDown: (idx: number) => void;
  onCellMouseEnter: (idx: number) => void;
  onChipDragStart: (drag: ChipDrag) => void;
  onChipDragEnd: () => void;
  onChipDrop: (toDate: string) => void;
  onRemove: (assignmentId: string) => void;
  pending: boolean;
}) {
  const color = projectColor(project.id);
  const dragLo = drag && drag.projectId === project.id ? Math.min(drag.startIdx, drag.endIdx) : -1;
  const dragHi = drag && drag.projectId === project.id ? Math.max(drag.startIdx, drag.endIdx) : -1;

  return (
    <>
      <div className="flex flex-col justify-center border-b border-r px-3 py-2">
        <div className="truncate text-sm font-medium">{project.name}</div>
        {project.customer_name ? (
          <div className="truncate text-xs text-muted-foreground">{project.customer_name}</div>
        ) : null}
      </div>
      {days.map((iso, idx) => {
        const items = cellLookup.get(`${project.id}|${iso}`) ?? [];
        const inDrag = idx >= dragLo && idx <= dragHi;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag-select target wraps interactive children
          <div
            key={iso}
            onMouseDown={(e) => {
              if ((e.target as HTMLElement).closest('button')) return;
              if ((e.target as HTMLElement).closest('[data-chip="1"]')) return;
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
              'group relative min-h-[60px] cursor-pointer border-b border-r p-1 text-left transition hover:bg-muted/40 last:border-r-0',
              isWeekend(iso) && 'bg-muted/10',
              isToday(iso) && 'ring-1 ring-inset ring-primary/40',
              inDrag && 'bg-primary/15 ring-1 ring-inset ring-primary/60',
              chipDrag &&
                chipDrag.projectId === project.id &&
                chipDrag.fromDate !== iso &&
                'bg-primary/5',
            )}
          >
            <div className="space-y-0.5">
              {items.map((a) => {
                const w = workerById.get(a.worker_profile_id);
                const isBeingDragged = chipDrag?.assignmentId === a.id;
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: drag handle for HTML5 DnD; keyboard alternative is the X remove + click-to-add
                  <div
                    key={a.id}
                    data-chip="1"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      // Required for Firefox to start the drag.
                      e.dataTransfer.setData('text/plain', a.id);
                      onChipDragStart({
                        assignmentId: a.id,
                        projectId: a.project_id,
                        workerProfileId: a.worker_profile_id,
                        fromDate: a.scheduled_date,
                      });
                    }}
                    onDragEnd={onChipDragEnd}
                    title="Drag to move to another day"
                    className={cn(
                      'flex cursor-grab items-center justify-between gap-1 rounded border px-1 py-0.5 text-[11px] active:cursor-grabbing',
                      color,
                      isBeingDragged && 'opacity-40',
                    )}
                  >
                    <span className="truncate">{w?.display_name ?? '?'}</span>
                    <button
                      type="button"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemove(a.id);
                      }}
                      disabled={pending}
                      className="opacity-0 transition hover:opacity-100 group-hover:opacity-60"
                      aria-label="Remove assignment"
                    >
                      <X className="size-2.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
