import { notFound } from 'next/navigation';
import { OwnerCalendar } from '@/components/features/calendar/owner-calendar';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getOwnerCalendarData } from '@/lib/db/queries/owner-calendar';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Calendar — HeyHenry',
};

function isoDate(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const sp = await searchParams;
  const ymRaw = typeof sp.ym === 'string' ? sp.ym : null;
  const view = sp.view === 'two-week' ? 'two-week' : 'month';

  // Anchor date: parse ?ym=YYYY-MM, default to today.
  let anchor = new Date();
  if (ymRaw && /^\d{4}-\d{2}$/.test(ymRaw)) {
    const [y, m] = ymRaw.split('-').map(Number);
    anchor = new Date(y, (m ?? 1) - 1, 1);
  }

  // Window: full month (padded to whole weeks) for month view; 14 days from
  // anchor for two-week view. Either way, we over-fetch by a few days to
  // cover the rendered grid edges.
  let windowStart: Date;
  let windowEnd: Date;
  if (view === 'two-week') {
    windowStart = new Date(anchor);
    windowEnd = new Date(anchor);
    windowEnd.setDate(windowEnd.getDate() + 13);
  } else {
    const ms = startOfMonth(anchor);
    const me = endOfMonth(anchor);
    windowStart = new Date(ms);
    windowStart.setDate(ms.getDate() - ms.getDay()); // back to Sunday
    windowEnd = new Date(me);
    windowEnd.setDate(me.getDate() + (6 - me.getDay())); // forward to Saturday
  }

  const { assignments, projects, workers, unavailability, timeSummaryByKey } =
    await getOwnerCalendarData(tenant.id, isoDate(windowStart), isoDate(windowEnd));

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        <p className="text-sm text-muted-foreground">
          All projects and worker assignments. Click a cell to schedule.
        </p>
      </div>
      <OwnerCalendar
        view={view}
        anchorDate={isoDate(anchor)}
        windowStart={isoDate(windowStart)}
        windowEnd={isoDate(windowEnd)}
        projects={projects}
        workers={workers}
        assignments={assignments}
        unavailability={unavailability}
        timeSummaryByKey={timeSummaryByKey}
      />
    </div>
  );
}
