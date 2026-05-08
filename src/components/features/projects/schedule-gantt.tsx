'use client';

/**
 * Gantt rendering for the operator's Schedule tab.
 *
 * Autoscale: the grid uses `repeat(totalDays, 1fr)` so the entire
 * project (earliest start → latest end) fits the available width
 * without horizontal scroll. Layered backing per row gives the eye
 * a reference frame: weekend bands, Monday gridlines, day-of-month
 * markers, and a today indicator if today falls in range.
 *
 * Interactivity is opt-in via callbacks:
 *  - `onTaskClick(task)` — wraps each row in a button + makes the bar
 *    clickable to open the edit modal.
 *  - `onTaskUpdate(taskId, patch)` — enables drag-to-reschedule and
 *    drag-to-resize. Pointer-event-based; the bar captures the pointer
 *    on mousedown, tracks deltaDays as the cursor moves, and fires the
 *    persisted update on release. A click without movement falls
 *    through to `onTaskClick`.
 */

import { useRef, useState } from 'react';
import type { ProjectScheduleTask } from '@/lib/db/queries/project-schedule';

const MONTH_FORMAT = new Intl.DateTimeFormat('en-CA', { month: 'short', year: 'numeric' });
const DAY_MS = 86_400_000;

function parseDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

function diffDays(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/**
 * Compute month-spanning header segments. Each segment knows its
 * column-start (1-indexed) and column-span — drives `gridColumnStart`
 * + `gridColumnEnd: span N`.
 */
function monthHeaderSegments(
  earliest: Date,
  totalDays: number,
): Array<{ label: string; start: number; span: number }> {
  const segments: Array<{ label: string; start: number; span: number }> = [];
  let cursor = 0;
  while (cursor < totalDays) {
    const dayDate = addDays(earliest, cursor);
    const monthEndDay = new Date(
      Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const daysLeftInMonth = monthEndDay - dayDate.getUTCDate() + 1;
    const span = Math.min(daysLeftInMonth, totalDays - cursor);
    segments.push({
      label: MONTH_FORMAT.format(dayDate),
      start: cursor + 1,
      span,
    });
    cursor += span;
  }
  return segments;
}

/**
 * Per-day classification used by the backing layer of every row.
 * Pre-computed once and reused so each row's render is just a map.
 */
type DayMeta = {
  isWeekend: boolean;
  isMonday: boolean;
  isToday: boolean;
  /** When this day starts a new week, the day-of-month label to show. */
  weekStartLabel: number | null;
};

function computeDayMeta(earliest: Date, totalDays: number): DayMeta[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const todayIndex = diffDays(today, earliest);
  const meta: DayMeta[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = addDays(earliest, i);
    const dow = d.getUTCDay();
    const isMonday = dow === 1;
    meta.push({
      isWeekend: dow === 0 || dow === 6,
      isMonday,
      isToday: i === todayIndex,
      // Show day-of-month at every Monday + the very first day so labels
      // are evenly spaced and the leading edge always has a marker.
      weekStartLabel: isMonday || i === 0 ? d.getUTCDate() : null,
    });
  }
  return meta;
}

/**
 * Render the per-day backing inside a single grid row. Pure DOM —
 * weekend shading, Monday gridlines, today accent. Bars overlay these
 * via DOM order (later-in-DOM = on top in CSS Grid).
 */
function DayBacking({ meta }: { meta: DayMeta[] }) {
  return (
    <>
      {meta.map((m, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: positional, never reorders
          key={i}
          aria-hidden="true"
          className={`pointer-events-none ${
            m.isWeekend ? 'bg-muted/40' : ''
          } ${m.isMonday ? 'border-l border-border/60' : ''} ${
            m.isToday ? 'border-l-2 border-amber-500/80' : ''
          }`}
          style={{ gridColumnStart: i + 1 }}
        />
      ))}
    </>
  );
}

type DragState = {
  taskId: string;
  kind: 'move' | 'resize';
  pointerStartX: number;
  origStart: Date;
  origDuration: number;
  deltaDays: number;
};

export function ScheduleGantt({
  tasks,
  onTaskClick,
  onTaskUpdate,
}: {
  tasks: ProjectScheduleTask[];
  onTaskClick?: (task: ProjectScheduleTask) => void;
  onTaskUpdate?: (
    taskId: string,
    patch: { planned_start_date?: string; planned_duration_days?: number },
  ) => void;
}) {
  // Callback ref so it doesn't fight the union type of BarCell (div or
  // button). The first task row registers itself as the measurement
  // surface for drag-day calculations.
  const gridRef = useRef<HTMLElement | null>(null);
  const setGridRef = (el: HTMLElement | null) => {
    gridRef.current = el;
  };
  const dragMovedRef = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  if (tasks.length === 0) return null;

  // Earliest start + latest end across all tasks. Latest end = start +
  // duration (exclusive); the bar ends ON the last day of work.
  const starts = tasks.map((t) => parseDate(t.planned_start_date));
  const ends = tasks.map((t, i) => addDays(starts[i], t.planned_duration_days));
  const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
  const latest = new Date(Math.max(...ends.map((d) => d.getTime())));
  const totalDays = Math.max(1, diffDays(latest, earliest));

  const months = monthHeaderSegments(earliest, totalDays);
  const dayMeta = computeDayMeta(earliest, totalDays);
  const interactive = Boolean(onTaskClick);
  const draggable = Boolean(onTaskUpdate);

  const gridCols = `repeat(${totalDays}, 1fr)`;

  const handleDragStart = (
    e: React.PointerEvent<HTMLElement>,
    task: ProjectScheduleTask,
    kind: 'move' | 'resize',
  ) => {
    if (!onTaskUpdate) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragMovedRef.current = false;
    setDrag({
      taskId: task.id,
      kind,
      pointerStartX: e.clientX,
      origStart: parseDate(task.planned_start_date),
      origDuration: task.planned_duration_days,
      deltaDays: 0,
    });
  };

  const handleDragMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag || !gridRef.current) return;
    const colWidth = gridRef.current.offsetWidth / totalDays;
    if (colWidth <= 0) return;
    const deltaDays = Math.round((e.clientX - drag.pointerStartX) / colWidth);
    if (deltaDays !== drag.deltaDays) {
      if (deltaDays !== 0) dragMovedRef.current = true;
      setDrag({ ...drag, deltaDays });
    }
  };

  const handleDragEnd = (e: React.PointerEvent<HTMLElement>) => {
    if (!drag) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const snapshot = drag;
    setDrag(null);
    if (snapshot.deltaDays === 0) return;
    if (snapshot.kind === 'move') {
      const newStart = addDays(snapshot.origStart, snapshot.deltaDays);
      onTaskUpdate?.(snapshot.taskId, {
        planned_start_date: newStart.toISOString().slice(0, 10),
      });
    } else {
      const newDuration = Math.max(1, snapshot.origDuration + snapshot.deltaDays);
      onTaskUpdate?.(snapshot.taskId, { planned_duration_days: newDuration });
    }
  };

  const handleBarClick = (e: React.MouseEvent, task: ProjectScheduleTask) => {
    e.stopPropagation();
    if (dragMovedRef.current) {
      // Click event fired as part of a drag-end — suppress.
      dragMovedRef.current = false;
      return;
    }
    onTaskClick?.(task);
  };

  // Compute optimistic position for the currently-dragging task.
  const positionFor = (task: ProjectScheduleTask, taskIndex: number) => {
    let colStart = diffDays(starts[taskIndex], earliest) + 1;
    let colSpan = task.planned_duration_days;
    if (drag && drag.taskId === task.id && drag.deltaDays !== 0) {
      if (drag.kind === 'move') colStart += drag.deltaDays;
      else colSpan = Math.max(1, colSpan + drag.deltaDays);
    }
    // Clamp into the visible timeline so the bar never paints into
    // negative columns. Drag-end persists the unclamped value, which
    // widens the timeline on the next render.
    if (colStart < 1) {
      colSpan = Math.max(1, colSpan + (colStart - 1));
      colStart = 1;
    }
    if (colStart + colSpan - 1 > totalDays) {
      colSpan = Math.max(1, totalDays - colStart + 1);
    }
    return { colStart, colSpan };
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="grid grid-cols-[180px_1fr] gap-x-3 px-3 py-2 text-xs">
        {/* Two header rows: months above, day-of-month markers below. */}
        <div />
        <div className="grid auto-rows-min" style={{ gridTemplateColumns: gridCols }}>
          <DayBacking meta={dayMeta} />
          {/* Month labels span their column range (row 1) */}
          {months.map((m) => (
            <div
              key={`${m.label}-${m.start}`}
              className="truncate font-semibold text-foreground"
              style={{
                gridRow: 1,
                gridColumnStart: m.start,
                gridColumnEnd: `span ${m.span}`,
              }}
            >
              {m.label}
            </div>
          ))}
          {/* Day-of-month markers (row 2) */}
          {dayMeta.map((m, i) =>
            m.weekStartLabel !== null ? (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: positional
                key={`d-${i}`}
                className="text-[10px] tabular-nums text-muted-foreground"
                style={{ gridRow: 2, gridColumnStart: i + 1 }}
              >
                {m.weekStartLabel}
              </div>
            ) : null,
          )}
          {/* Bottom border under both header rows (visual separator) */}
          <div
            className="border-b"
            style={{ gridRow: 3, gridColumnStart: 1, gridColumnEnd: `span ${totalDays}` }}
          />
        </div>

        {tasks.map((task, i) => {
          const { colStart, colSpan } = positionFor(task, i);
          const isFirm = task.confidence === 'firm';
          const isDone = task.status === 'done';
          const isDragging = drag?.taskId === task.id;
          const barClasses = isDone
            ? 'bg-emerald-500'
            : isFirm
              ? 'bg-primary'
              : 'border border-dashed border-primary bg-primary/10';
          const NameCell = interactive ? 'button' : 'div';
          const BarCell = interactive ? 'button' : 'div';
          // First row carries the gridRef so we can measure column width
          // for drag-day calculations.
          return (
            <div key={task.id} className="contents">
              <NameCell
                {...(interactive ? { type: 'button' as const } : {})}
                onClick={interactive ? () => onTaskClick?.(task) : undefined}
                className={`flex min-h-8 items-center truncate py-1 text-left text-sm ${
                  interactive ? 'cursor-pointer rounded hover:bg-muted/50' : ''
                }`}
              >
                <span className={isDone ? 'text-muted-foreground line-through' : ''}>
                  {task.name}
                </span>
                {task.client_visible ? null : (
                  <span
                    className="ml-1.5 text-[10px] text-muted-foreground"
                    title="Hidden from customer"
                  >
                    (internal)
                  </span>
                )}
              </NameCell>
              <BarCell
                {...(interactive ? { type: 'button' as const } : {})}
                onClick={interactive ? () => onTaskClick?.(task) : undefined}
                ref={i === 0 ? setGridRef : undefined}
                className={`relative grid min-h-8 ${interactive ? 'cursor-pointer' : ''}`}
                style={{ gridTemplateColumns: gridCols }}
              >
                <DayBacking meta={dayMeta} />
                <button
                  type="button"
                  aria-label={`${task.name} — ${task.planned_duration_days} days. Click to edit.`}
                  onPointerDown={draggable ? (e) => handleDragStart(e, task, 'move') : undefined}
                  onPointerMove={draggable && isDragging ? handleDragMove : undefined}
                  onPointerUp={draggable && isDragging ? handleDragEnd : undefined}
                  onPointerCancel={draggable && isDragging ? handleDragEnd : undefined}
                  onClick={(e) => handleBarClick(e, task)}
                  className={`group relative my-1 h-5 self-center rounded-md border-0 p-0 shadow-sm transition-opacity ${barClasses} ${
                    draggable
                      ? isDragging
                        ? 'cursor-grabbing opacity-90'
                        : 'cursor-grab hover:opacity-90'
                      : interactive
                        ? 'hover:opacity-90'
                        : ''
                  }`}
                  style={{
                    gridRow: 1,
                    gridColumnStart: colStart,
                    gridColumnEnd: `span ${colSpan}`,
                    touchAction: 'none',
                  }}
                  title={`${task.name} — ${task.planned_duration_days}d (${task.confidence})`}
                >
                  {draggable ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label="Drag to resize task duration"
                      onPointerDown={(e) => handleDragStart(e, task, 'resize')}
                      onPointerMove={isDragging ? handleDragMove : undefined}
                      onPointerUp={isDragging ? handleDragEnd : undefined}
                      onPointerCancel={isDragging ? handleDragEnd : undefined}
                      className="absolute right-0 top-0 z-10 h-full w-2 cursor-ew-resize rounded-r-md border-0 bg-transparent p-0 opacity-0 transition-opacity hover:bg-foreground/20 hover:opacity-100 group-hover:opacity-60"
                      style={{ touchAction: 'none' }}
                    />
                  ) : null}
                </button>
              </BarCell>
            </div>
          );
        })}
      </div>
    </div>
  );
}
