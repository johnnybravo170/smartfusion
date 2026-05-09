/**
 * Customer-facing read-only Gantt for the portal Schedule tab.
 *
 * Same CSS-grid autoscale as the operator's view, but tuned for the
 * homeowner: hides internal-only labels, hides the operator's
 * confidence-vs-status visual variants, and renders a small
 * "plan to be out" warning under any task whose underlying trade is
 * high-disruption.
 *
 * Layered backing per row gives the eye a reference frame: weekend
 * bands, Monday gridlines, day-of-month markers, and a today indicator
 * if today falls in range.
 */

import type { ProjectScheduleTask } from '@/lib/db/queries/project-schedule';
import { phaseColorFor } from '@/lib/ui/gantt-phase-colors';

const MONTH_FORMAT = new Intl.DateTimeFormat('en-CA', { month: 'short', year: 'numeric' });
const DAY_FMT = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric' });
const DAY_FMT_WITH_YEAR = new Intl.DateTimeFormat('en-CA', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const DAY_MS = 86_400_000;

function parseDate(yyyyMmDd: string): Date {
  return new Date(`${yyyyMmDd}T00:00:00Z`);
}

/**
 * "Mar 16" / "Mar 16 – Mar 18" / "Dec 28, 2025 – Jan 4, 2026" depending
 * on duration and whether the window crosses a year. Inclusive end —
 * the last day of work, not the day after.
 */
function formatDateRange(startStr: string, durationDays: number): string {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + Math.max(0, durationDays - 1));
  if (durationDays <= 1) return DAY_FMT.format(start);
  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const fmt = sameYear ? DAY_FMT : DAY_FMT_WITH_YEAR;
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

function diffDays(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / DAY_MS);
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

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

type DayMeta = {
  isWeekend: boolean;
  isMonday: boolean;
  isToday: boolean;
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
      weekStartLabel: isMonday || i === 0 ? d.getUTCDate() : null,
    });
  }
  return meta;
}

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

export type PortalScheduleTaskView = ProjectScheduleTask & {
  /** Generic warning copy when the underlying trade is high-disruption. */
  warning: string | null;
  /** Phase name resolved from `phase_id` — drives bar color. */
  phaseName: string | null;
};

export function PortalScheduleGantt({ tasks }: { tasks: PortalScheduleTaskView[] }) {
  if (tasks.length === 0) return null;

  const starts = tasks.map((t) => parseDate(t.planned_start_date));
  const ends = tasks.map((t, i) => addDays(starts[i], t.planned_duration_days));
  const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
  const latest = new Date(Math.max(...ends.map((d) => d.getTime())));
  const totalDays = Math.max(1, diffDays(latest, earliest));

  const months = monthHeaderSegments(earliest, totalDays);
  const dayMeta = computeDayMeta(earliest, totalDays);
  // minmax(12px, 1fr) keeps each day-column at least 12px wide on
  // narrow screens; the outer wrapper scrolls horizontally instead of
  // compressing bars to invisible dots.
  const gridCols = `repeat(${totalDays}, minmax(12px, 1fr))`;

  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <div className="grid grid-cols-[110px_1fr] gap-x-3 px-3 py-2 text-xs sm:grid-cols-[140px_1fr]">
        {/* Sticky top-left so it covers the timeline header on
            horizontal scroll. */}
        <div className="sticky left-0 z-20 bg-card" />
        <div className="grid auto-rows-min" style={{ gridTemplateColumns: gridCols }}>
          <DayBacking meta={dayMeta} />
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
          <div
            className="border-b"
            style={{ gridRow: 3, gridColumnStart: 1, gridColumnEnd: `span ${totalDays}` }}
          />
        </div>

        {tasks.map((task, i) => {
          const taskStart = starts[i];
          const colStart = diffDays(taskStart, earliest) + 1;
          const colSpan = task.planned_duration_days;
          const isDone = task.status === 'done';
          return (
            <div key={task.id} className="contents">
              <div className="sticky left-0 z-20 flex min-h-8 flex-col justify-center truncate bg-card py-1 pr-2 text-sm">
                <span className={isDone ? 'text-muted-foreground line-through' : ''}>
                  {task.name}
                </span>
                {task.warning ? (
                  <span className="mt-0.5 text-[11px] font-medium text-amber-700">
                    ⚠ {task.warning}
                  </span>
                ) : null}
              </div>
              <div className="relative grid min-h-8" style={{ gridTemplateColumns: gridCols }}>
                <DayBacking meta={dayMeta} />
                <div
                  role="img"
                  aria-label={`${task.name} · ${formatDateRange(task.planned_start_date, task.planned_duration_days)} · ${task.planned_duration_days} ${task.planned_duration_days === 1 ? 'day' : 'days'}`}
                  className={`group relative my-1 h-5 self-center rounded-md shadow-sm ${
                    isDone
                      ? 'bg-emerald-500'
                      : task.warning
                        ? 'bg-amber-500'
                        : phaseColorFor(task.phaseName).firm
                  }`}
                  style={{
                    gridRow: 1,
                    gridColumnStart: colStart,
                    gridColumnEnd: `span ${colSpan}`,
                  }}
                >
                  <span
                    role="tooltip"
                    className="pointer-events-none invisible absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2.5 py-1.5 text-xs font-medium text-background opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
                  >
                    {task.name} ·{' '}
                    {formatDateRange(task.planned_start_date, task.planned_duration_days)} ·{' '}
                    {task.planned_duration_days} {task.planned_duration_days === 1 ? 'day' : 'days'}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
