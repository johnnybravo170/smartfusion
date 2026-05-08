'use client';

/**
 * Built-in calendar view for jobs.
 *
 * Month grid (desktop) and stacked day list (mobile). No external calendar
 * library -- just a simple CSS grid + date math.
 */

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { JobWithCustomer } from '@/lib/db/queries/jobs';
import { cn } from '@/lib/utils';

type CalendarView = 'month' | 'week';

type Props = {
  jobs: JobWithCustomer[];
  initialYear: number;
  initialMonth: number;
};

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

const STATUS_COLORS: Record<string, string> = {
  booked: 'bg-sky-100 text-sky-800 border-sky-200',
  in_progress: 'bg-amber-100 text-amber-800 border-amber-200',
  complete: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
};

function formatDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getJobDate(job: JobWithCustomer): string | null {
  if (!job.scheduled_at) return null;
  const d = new Date(job.scheduled_at);
  return formatDateKey(d);
}

function getJobTime(job: JobWithCustomer, tz: string): string {
  if (!job.scheduled_at) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(job.scheduled_at));
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function JobPill({ job, tz }: { job: JobWithCustomer; tz: string }) {
  const color = STATUS_COLORS[job.status] ?? STATUS_COLORS.booked;
  const label = job.customer?.name ?? 'Job';
  const time = getJobTime(job, tz);

  return (
    <Link
      href={`/jobs/${job.id}`}
      className={cn(
        'block truncate rounded border px-1.5 py-0.5 text-xs font-medium transition-opacity hover:opacity-80',
        color,
      )}
      title={`${label}${time ? ` at ${time}` : ''}`}
    >
      {time ? `${time} ` : ''}
      {label}
    </Link>
  );
}

function getMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  const days: Date[] = [];

  // Fill leading days from previous month
  const startDow = firstDay.getDay();
  for (let i = startDow - 1; i >= 0; i--) {
    days.push(new Date(year, month, -i));
  }

  // Days of the month
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }

  // Fill trailing days to complete grid (always 6 rows = 42 cells)
  while (days.length < 42) {
    const last = days[days.length - 1];
    days.push(new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1));
  }

  return days;
}

function getWeekDays(startDate: Date) {
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i));
  }
  return days;
}

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

export function JobCalendar({ jobs, initialYear, initialMonth }: Props) {
  const tz = useTenantTimezone();
  const router = useRouter();
  const today = new Date();

  const [year, setYear] = useState(initialYear);
  const [month, setMonth] = useState(initialMonth);
  const [view, setView] = useState<CalendarView>('month');
  const [weekStart, setWeekStart] = useState(() => getWeekStart(today));

  // Index jobs by date key
  const jobsByDate = new Map<string, JobWithCustomer[]>();
  for (const job of jobs) {
    const key = getJobDate(job);
    if (!key) continue;
    const arr = jobsByDate.get(key) ?? [];
    arr.push(job);
    jobsByDate.set(key, arr);
  }

  const navigateMonth = useCallback(
    (delta: number) => {
      let newMonth = month + delta;
      let newYear = year;
      if (newMonth < 0) {
        newMonth = 11;
        newYear--;
      }
      if (newMonth > 11) {
        newMonth = 0;
        newYear++;
      }
      setMonth(newMonth);
      setYear(newYear);
      router.push(`/jobs/calendar?year=${newYear}&month=${newMonth + 1}`);
    },
    [month, year, router],
  );

  const navigateWeek = useCallback(
    (delta: number) => {
      const next = new Date(weekStart);
      next.setDate(next.getDate() + delta * 7);
      setWeekStart(next);
      // Also navigate to fetch data for new range
      const m = next.getMonth();
      const y = next.getFullYear();
      if (m !== month || y !== year) {
        setMonth(m);
        setYear(y);
        router.push(`/jobs/calendar?year=${y}&month=${m + 1}`);
      }
    },
    [weekStart, month, year, router],
  );

  const goToday = useCallback(() => {
    const now = new Date();
    setYear(now.getFullYear());
    setMonth(now.getMonth());
    setWeekStart(getWeekStart(now));
    router.push(`/jobs/calendar?year=${now.getFullYear()}&month=${now.getMonth() + 1}`);
  }, [router]);

  const handleDayClick = useCallback(
    (date: Date) => {
      const dateStr = formatDateKey(date);
      router.push(`/jobs/new?scheduled_at=${dateStr}`);
    },
    [router],
  );

  const days = view === 'month' ? getMonthDays(year, month) : getWeekDays(weekStart);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            onClick={() => (view === 'month' ? navigateMonth(-1) : navigateWeek(-1))}
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <h2 className="min-w-[160px] text-center text-lg font-semibold">
            {view === 'month'
              ? `${MONTH_NAMES[month]} ${year}`
              : `Week of ${new Intl.DateTimeFormat('en-CA', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(weekStart)}`}
          </h2>
          <Button
            variant="outline"
            size="xs"
            onClick={() => (view === 'month' ? navigateMonth(1) : navigateWeek(1))}
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <Button variant="outline" size="xs" onClick={goToday}>
            Today
          </Button>
        </div>

        <div className="inline-flex items-center rounded-md border bg-card p-0.5">
          <Button
            size="xs"
            variant={view === 'month' ? 'secondary' : 'ghost'}
            className={cn(view === 'month' && 'shadow-sm')}
            onClick={() => setView('month')}
          >
            Month
          </Button>
          <Button
            size="xs"
            variant={view === 'week' ? 'secondary' : 'ghost'}
            className={cn(view === 'week' && 'shadow-sm')}
            onClick={() => setView('week')}
          >
            Week
          </Button>
        </div>
      </div>

      {/* Desktop: Grid */}
      <div className="hidden sm:block">
        {/* Day headers */}
        <div className="grid grid-cols-7 border-b">
          {DAY_NAMES.map((d) => (
            <div key={d} className="py-2 text-center text-xs font-medium text-muted-foreground">
              {d}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div className="grid grid-cols-7">
          {days.map((date) => {
            const key = formatDateKey(date);
            const isCurrentMonth = date.getMonth() === month;
            const isToday = isSameDay(date, today);
            const dayJobs = jobsByDate.get(key) ?? [];
            const colIdx = date.getDay();

            return (
              // biome-ignore lint/a11y/useSemanticElements: cell wraps Link pills, can't be a <button>
              <div
                key={key}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  // Ignore clicks on the pills (Links navigate themselves).
                  if ((e.target as HTMLElement).closest('a,button')) return;
                  handleDayClick(date);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleDayClick(date);
                  }
                }}
                className={cn(
                  'min-h-[100px] cursor-pointer border-b border-r p-1.5 transition-colors hover:bg-muted/40',
                  view === 'week' ? 'min-h-[200px]' : '',
                  !isCurrentMonth && view === 'month' && 'bg-muted/30',
                  colIdx === 0 && 'border-l',
                )}
              >
                <div
                  className={cn(
                    'mb-1 flex size-7 items-center justify-center rounded-full text-sm',
                    isToday && 'bg-foreground text-background font-bold',
                    !isCurrentMonth && view === 'month' && 'text-muted-foreground',
                  )}
                >
                  {date.getDate()}
                </div>
                <div className="flex flex-col gap-0.5">
                  {dayJobs.slice(0, view === 'week' ? 10 : 3).map((job) => (
                    <JobPill key={job.id} job={job} tz={tz} />
                  ))}
                  {dayJobs.length > (view === 'week' ? 10 : 3) && (
                    <span className="px-1.5 text-xs text-muted-foreground">
                      +{dayJobs.length - (view === 'week' ? 10 : 3)} more
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile: Stacked day list */}
      <div className="flex flex-col gap-2 sm:hidden">
        {days
          .filter((d) => view === 'week' || d.getMonth() === month)
          .map((date) => {
            const key = formatDateKey(date);
            const isToday = isSameDay(date, today);
            const dayJobs = jobsByDate.get(key) ?? [];

            return (
              <div
                key={key}
                className={cn(
                  'rounded-lg border p-3',
                  isToday && 'border-foreground/30 bg-muted/50',
                )}
              >
                <button
                  type="button"
                  onClick={() => handleDayClick(date)}
                  className="mb-2 text-sm font-medium hover:underline"
                >
                  {new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz,
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  }).format(date)}
                  {isToday && (
                    <span className="ml-2 rounded-full bg-foreground px-2 py-0.5 text-xs text-background">
                      Today
                    </span>
                  )}
                </button>
                {dayJobs.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No jobs</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {dayJobs.map((job) => (
                      <JobPill key={job.id} job={job} tz={tz} />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}
