import { ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import Link from 'next/link';
import { UnavailabilityForm } from '@/components/features/worker/unavailability-form';
import { UnavailabilityRow } from '@/components/features/worker/unavailability-row';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireWorker } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { listUnavailabilityForWorker, REASON_LABELS } from '@/lib/db/queries/worker-unavailability';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function parseMonthParam(raw: string | undefined): { year: number; month: number } {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const [y, m] = raw.split('-').map(Number);
    return { year: y, month: m - 1 };
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() };
}

function toISO(d: Date): string {
  return d.toLocaleDateString('en-CA');
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0);
  return { start: toISO(start), end: toISO(end) };
}

export default async function WorkerCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; date?: string }>;
}) {
  const sp = await searchParams;
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const { year, month } = parseMonthParam(sp.month);
  const { start, end } = monthRange(year, month);
  const selectedDate = sp.date ?? '';

  const admin = createAdminClient();

  const [assignmentsRes, timeRes, unavailability] = await Promise.all([
    admin
      .from('project_assignments')
      .select('project_id, scheduled_date, projects:project_id (name)')
      .eq('tenant_id', tenant.id)
      .eq('worker_profile_id', profile.id)
      .gte('scheduled_date', start)
      .lte('scheduled_date', end),
    admin
      .from('time_entries')
      .select('id, entry_date, hours, project_id, projects:project_id (name), notes')
      .eq('tenant_id', tenant.id)
      .eq('worker_profile_id', profile.id)
      .gte('entry_date', start)
      .lte('entry_date', end),
    listUnavailabilityForWorker(tenant.id, profile.id, start, end),
  ]);

  const scheduledByDate = new Map<string, Array<{ project_id: string; project_name: string }>>();
  for (const r of (assignmentsRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
    const d = r.scheduled_date as string | null;
    if (!d) continue;
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const arr = scheduledByDate.get(d) ?? [];
    arr.push({ project_id: r.project_id as string, project_name: p?.name ?? 'Project' });
    scheduledByDate.set(d, arr);
  }

  const timeByDate = new Map<
    string,
    Array<{ id: string; hours: number; project_name: string | null; notes: string | null }>
  >();
  for (const r of (timeRes.data ?? []) as unknown as Array<Record<string, unknown>>) {
    const d = r.entry_date as string;
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    const arr = timeByDate.get(d) ?? [];
    arr.push({
      id: r.id as string,
      hours: Number(r.hours),
      project_name: p?.name ?? null,
      notes: (r.notes as string | null) ?? null,
    });
    timeByDate.set(d, arr);
  }

  const unavailableByDate = new Map(unavailability.map((u) => [u.unavailable_date, u]));

  // Build grid cells: pad to Monday-start week.
  const first = new Date(year, month, 1);
  const leading = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<{ iso: string | null; day: number | null }> = [];
  for (let i = 0; i < leading; i++) cells.push({ iso: null, day: null });
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = toISO(new Date(year, month, d));
    cells.push({ iso, day: d });
  }
  while (cells.length % 7 !== 0) cells.push({ iso: null, day: null });

  const today = toISO(new Date());
  const prevMonth = new Date(year, month - 1, 1);
  const nextMonth = new Date(year, month + 1, 1);
  const monthLabel = first.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });

  const selScheduled = selectedDate ? (scheduledByDate.get(selectedDate) ?? []) : [];
  const selTime = selectedDate ? (timeByDate.get(selectedDate) ?? []) : [];
  const selUnavailable = selectedDate ? unavailableByDate.get(selectedDate) : undefined;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Calendar</h1>

      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="icon">
          <Link
            href={`/w/calendar?month=${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`}
            aria-label="Previous month"
          >
            <ChevronLeft className="size-4" />
          </Link>
        </Button>
        <p className="text-sm font-medium">{monthLabel}</p>
        <Button asChild variant="ghost" size="icon">
          <Link
            href={`/w/calendar?month=${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}`}
            aria-label="Next month"
          >
            <ChevronRight className="size-4" />
          </Link>
        </Button>
      </div>

      <div className="grid grid-cols-7 gap-px rounded-md bg-border text-center text-xs">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <div key={d} className="bg-background py-1 text-muted-foreground">
            {d.slice(0, 1)}
          </div>
        ))}
        {cells.map((c, i) => {
          if (!c.iso) {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: padding cells are positional
              <div key={`pad-${year}-${month}-${i}`} className="aspect-square bg-background" />
            );
          }
          const isToday = c.iso === today;
          const isSelected = c.iso === selectedDate;
          const hasScheduled = scheduledByDate.has(c.iso);
          const hasTime = timeByDate.has(c.iso);
          const isUnavailable = unavailableByDate.has(c.iso);
          const monthParam = `${year}-${String(month + 1).padStart(2, '0')}`;
          return (
            <Link
              key={c.iso}
              href={`/w/calendar?month=${monthParam}&date=${c.iso}`}
              className={`flex aspect-square flex-col items-center justify-center gap-1 bg-background text-sm ${
                isSelected
                  ? 'bg-foreground text-background'
                  : isToday
                    ? 'font-semibold text-foreground'
                    : 'text-foreground'
              }`}
            >
              <span>{c.day}</span>
              <span className="flex h-1.5 items-center gap-0.5">
                {hasScheduled ? <span className="size-1.5 rounded-full bg-blue-500" /> : null}
                {hasTime ? <span className="size-1.5 rounded-full bg-emerald-500" /> : null}
                {isUnavailable ? <span className="size-1.5 rounded-full bg-amber-500" /> : null}
              </span>
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-blue-500" /> Scheduled
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-emerald-500" /> Logged
        </span>
        <span className="flex items-center gap-1">
          <span className="size-2 rounded-full bg-amber-500" /> Unavailable
        </span>
      </div>

      {selectedDate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {new Date(`${selectedDate}T00:00`).toLocaleDateString('en-CA', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            {selUnavailable ? (
              <UnavailabilityRow
                workerProfileId={profile.id}
                date={selectedDate}
                reasonLabel={REASON_LABELS[selUnavailable.reason_tag]}
                reasonText={selUnavailable.reason_text}
              />
            ) : null}

            {selScheduled.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Scheduled</p>
                {selScheduled.map((s) => (
                  <div
                    key={s.project_id}
                    className="flex items-center justify-between gap-3 rounded-md border p-3"
                  >
                    <Link href={`/w/projects/${s.project_id}`} className="font-medium">
                      {s.project_name}
                    </Link>
                    <Button asChild size="sm" variant="secondary">
                      <Link href={`/w/time/new?project=${s.project_id}&date=${selectedDate}`}>
                        <Clock className="size-4" /> Log
                      </Link>
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}

            {selTime.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase text-muted-foreground">Logged</p>
                {selTime.map((t) => (
                  <div key={t.id} className="rounded-md border p-3">
                    <p className="font-medium">
                      {t.hours.toFixed(2)}h
                      {t.project_name ? (
                        <span className="ml-2 font-normal text-muted-foreground">
                          {t.project_name}
                        </span>
                      ) : null}
                    </p>
                    {t.notes ? <p className="text-xs text-muted-foreground">{t.notes}</p> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {!selUnavailable ? (
              <UnavailabilityForm workerProfileId={profile.id} date={selectedDate} />
            ) : null}
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">Tap a day to see details or book time off.</p>
      )}
    </div>
  );
}
