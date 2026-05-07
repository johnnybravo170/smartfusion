/**
 * Customer-facing read-only Gantt for the portal Schedule tab.
 *
 * Same CSS-grid autoscale as the operator's view, but tuned for the
 * homeowner: hides internal-only labels, hides the operator's
 * confidence-vs-status visual variants (customer just wants to know
 * roughly when things happen), and renders a small "plan to be out"
 * warning under any task whose underlying trade is high-disruption.
 *
 * Data shape includes a per-task disruption hint and warning copy so
 * this component stays pure rendering — the tab-server resolves the
 * trade-template lookup once and feeds it in.
 */

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

export type PortalScheduleTaskView = ProjectScheduleTask & {
  /** Generic warning copy when the underlying trade is high-disruption. */
  warning: string | null;
};

export function PortalScheduleGantt({ tasks }: { tasks: PortalScheduleTaskView[] }) {
  if (tasks.length === 0) return null;

  const starts = tasks.map((t) => parseDate(t.planned_start_date));
  const ends = tasks.map((t, i) => addDays(starts[i], t.planned_duration_days));
  const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
  const latest = new Date(Math.max(...ends.map((d) => d.getTime())));
  const totalDays = Math.max(1, diffDays(latest, earliest));

  const months = monthHeaderSegments(earliest, totalDays);

  return (
    <div className="rounded-lg border bg-card">
      <div className="grid grid-cols-[140px_1fr] gap-x-3 px-3 py-2 text-xs">
        <div />
        <div
          className="grid border-b pb-1"
          style={{ gridTemplateColumns: `repeat(${totalDays}, 1fr)` }}
        >
          {months.map((m) => (
            <div
              key={`${m.label}-${m.start}`}
              className="truncate font-medium text-muted-foreground"
              style={{
                gridColumnStart: m.start,
                gridColumnEnd: `span ${m.span}`,
              }}
            >
              {m.label}
            </div>
          ))}
        </div>

        {tasks.map((task, i) => {
          const taskStart = starts[i];
          const colStart = diffDays(taskStart, earliest) + 1;
          const colSpan = task.planned_duration_days;
          const isDone = task.status === 'done';
          return (
            <div key={task.id} className="contents">
              <div className="flex flex-col justify-center truncate py-1.5 text-sm">
                <span className={isDone ? 'text-muted-foreground line-through' : ''}>
                  {task.name}
                </span>
                {task.warning ? (
                  <span className="mt-0.5 text-[11px] font-medium text-amber-700">
                    ⚠ {task.warning}
                  </span>
                ) : null}
              </div>
              <div
                className="grid items-center py-1.5"
                style={{ gridTemplateColumns: `repeat(${totalDays}, 1fr)` }}
              >
                <div
                  className={`h-5 rounded-sm ${
                    isDone ? 'bg-emerald-500' : task.warning ? 'bg-amber-500' : 'bg-primary'
                  }`}
                  style={{
                    gridColumnStart: colStart,
                    gridColumnEnd: `span ${colSpan}`,
                  }}
                  title={task.name}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
