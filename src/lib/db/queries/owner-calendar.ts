/**
 * Tenant-wide schedule queries for the Owner Calendar view.
 *
 * Pulls every project_assignments row in a date window for the current
 * tenant, joined to project + worker basics, so the calendar can render
 * project-rows with worker chips per day.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type CalendarAssignment = {
  id: string;
  project_id: string;
  worker_profile_id: string;
  scheduled_date: string;
  notes: string | null;
  hourly_rate_cents: number | null;
  charge_rate_cents: number | null;
};

/**
 * Per-(worker, project, date) time summary in the calendar window.
 * Map key format: `${worker_profile_id}:${project_id}:${entry_date}`.
 * Used by the chip detail dialog to surface "what actually happened
 * that day" alongside the bare assignment row.
 */
export type CalendarTimeSummary = {
  hours: number;
  categoryNames: string[];
};

export type CalendarProject = {
  id: string;
  name: string;
  lifecycle_stage: string;
  customer_name: string | null;
};

export type CalendarWorker = {
  profile_id: string;
  display_name: string;
};

export type CalendarUnavailability = {
  worker_profile_id: string;
  unavailable_date: string;
  reason_tag: string;
};

export type OwnerCalendarData = {
  assignments: CalendarAssignment[];
  projects: CalendarProject[];
  workers: CalendarWorker[];
  unavailability: CalendarUnavailability[];
  /** Map of `${worker_profile_id}:${project_id}:${entry_date}` →
   *  aggregated hours + budget-category names worked on that day. */
  timeSummaryByKey: Record<string, CalendarTimeSummary>;
};

export async function getOwnerCalendarData(
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<OwnerCalendarData> {
  const admin = createAdminClient();

  const [assignmentsRes, workersRes, projectsRes, unavailRes, timeRes] = await Promise.all([
    admin
      .from('project_assignments')
      .select(
        'id, project_id, worker_profile_id, scheduled_date, notes, hourly_rate_cents, charge_rate_cents',
      )
      .eq('tenant_id', tenantId)
      .not('scheduled_date', 'is', null)
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate),
    admin
      .from('worker_profiles')
      .select('id, display_name, tenant_member_id')
      .eq('tenant_id', tenantId),
    admin
      .from('projects')
      .select('id, name, lifecycle_stage, customers:customer_id (name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin
      .from('worker_unavailability')
      .select('worker_profile_id, unavailable_date, reason_tag')
      .eq('tenant_id', tenantId)
      .gte('unavailable_date', startDate)
      .lte('unavailable_date', endDate),
    // Pull every time entry in the window with the linked budget-category
    // name. Aggregated below into Map keyed by (worker, project, date) so
    // the chip dialog can show "what actually happened that day."
    admin
      .from('time_entries')
      .select(
        'worker_profile_id, project_id, entry_date, hours, budget_category:budget_category_id (name)',
      )
      .eq('tenant_id', tenantId)
      .not('worker_profile_id', 'is', null)
      .not('project_id', 'is', null)
      .gte('entry_date', startDate)
      .lte('entry_date', endDate),
  ]);

  if (assignmentsRes.error) throw new Error(assignmentsRes.error.message);
  if (workersRes.error) throw new Error(workersRes.error.message);
  if (projectsRes.error) throw new Error(projectsRes.error.message);
  if (unavailRes.error) throw new Error(unavailRes.error.message);
  if (timeRes.error) throw new Error(timeRes.error.message);

  const assignments: CalendarAssignment[] = (assignmentsRes.data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    worker_profile_id: r.worker_profile_id as string,
    scheduled_date: r.scheduled_date as string,
    notes: (r.notes as string | null) ?? null,
    hourly_rate_cents: (r.hourly_rate_cents as number | null) ?? null,
    charge_rate_cents: (r.charge_rate_cents as number | null) ?? null,
  }));

  const timeSummaryByKey: Record<string, CalendarTimeSummary> = {};
  for (const row of (timeRes.data ?? []) as Array<Record<string, unknown>>) {
    const wp = row.worker_profile_id as string;
    const pid = row.project_id as string;
    const date = row.entry_date as string;
    const hours = Number(row.hours ?? 0);
    const cat = row.budget_category as { name?: string } | { name?: string }[] | null;
    const catObj = Array.isArray(cat) ? cat[0] : cat;
    const catName = (catObj?.name as string | undefined) ?? null;

    const key = `${wp}:${pid}:${date}`;
    const existing = timeSummaryByKey[key] ?? { hours: 0, categoryNames: [] };
    existing.hours += hours;
    if (catName && !existing.categoryNames.includes(catName)) {
      existing.categoryNames.push(catName);
    }
    timeSummaryByKey[key] = existing;
  }

  const workers: CalendarWorker[] = (workersRes.data ?? []).map((w) => ({
    profile_id: w.id as string,
    display_name: (w.display_name as string | null) ?? 'Worker',
  }));

  const projects: CalendarProject[] = (
    (projectsRes.data ?? []) as Array<Record<string, unknown>>
  ).map((p) => {
    const cs = p.customers as { name?: string } | { name?: string }[] | null;
    const customer = Array.isArray(cs) ? cs[0] : cs;
    return {
      id: p.id as string,
      name: p.name as string,
      lifecycle_stage: p.lifecycle_stage as string,
      customer_name: (customer?.name as string | undefined) ?? null,
    };
  });

  const unavailability: CalendarUnavailability[] = (unavailRes.data ?? []).map((u) => ({
    worker_profile_id: u.worker_profile_id as string,
    unavailable_date: u.unavailable_date as string,
    reason_tag: u.reason_tag as string,
  }));

  return { assignments, projects, workers, unavailability, timeSummaryByKey };
}
