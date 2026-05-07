/**
 * Read-only Gantt rendering for the operator's Schedule tab.
 *
 * Autoscale: the grid uses `repeat(totalDays, 1fr)` so the entire
 * project (earliest start → latest end) fits the available width
 * without horizontal scroll. A monthly header row labels months by
 * spanning whichever columns fall inside that month.
 *
 * v0 is read-only. v1 (kanban 6f110321) wraps each bar in a drag
 * handler that updates planned_start_date.
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
    // Days remaining in this month from the cursor day.
    const monthEndDay = new Date(
      Date.UTC(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const daysLeftInMonth = monthEndDay - dayDate.getUTCDate() + 1;
    const span = Math.min(daysLeftInMonth, totalDays - cursor);
    segments.push({
      label: MONTH_FORMAT.format(dayDate),
      start: cursor + 1, // CSS grid columns are 1-indexed
      span,
    });
    cursor += span;
  }
  return segments;
}

export function ScheduleGantt({ tasks }: { tasks: ProjectScheduleTask[] }) {
  if (tasks.length === 0) return null;

  // Earliest start + latest end across all tasks. Latest end = start +
  // duration (exclusive); the bar ends ON the last day of work.
  const starts = tasks.map((t) => parseDate(t.planned_start_date));
  const ends = tasks.map((t, i) => addDays(starts[i], t.planned_duration_days));
  const earliest = new Date(Math.min(...starts.map((d) => d.getTime())));
  const latest = new Date(Math.max(...ends.map((d) => d.getTime())));
  const totalDays = Math.max(1, diffDays(latest, earliest));

  const months = monthHeaderSegments(earliest, totalDays);

  // Two-column layout: task name list (fixed-ish width) + Gantt grid
  // (autoscale). Both scroll as a unit vertically.
  return (
    <div className="rounded-lg border bg-card">
      <div className="grid grid-cols-[200px_1fr] gap-x-3 px-3 py-2 text-xs">
        {/* Header row: blank above task names, month segments above grid */}
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
          const isFirm = task.confidence === 'firm';
          const isDone = task.status === 'done';
          // rough = muted, dashed; firm = solid primary; done = solid emerald.
          const barClasses = isDone
            ? 'bg-emerald-500'
            : isFirm
              ? 'bg-primary'
              : 'border-2 border-dashed border-primary/60 bg-primary/10';
          return (
            <div key={task.id} className="contents">
              <div className="flex items-center truncate py-1.5 text-sm">
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
              </div>
              <div
                className="grid items-center py-1.5"
                style={{ gridTemplateColumns: `repeat(${totalDays}, 1fr)` }}
              >
                <div
                  className={`h-5 rounded-sm ${barClasses}`}
                  style={{
                    gridColumnStart: colStart,
                    gridColumnEnd: `span ${colSpan}`,
                  }}
                  title={`${task.name} — ${task.planned_duration_days}d (${task.confidence})`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
