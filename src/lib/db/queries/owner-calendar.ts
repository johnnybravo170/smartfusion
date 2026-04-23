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
};

export type CalendarProject = {
  id: string;
  name: string;
  status: string;
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
};

export async function getOwnerCalendarData(
  tenantId: string,
  startDate: string,
  endDate: string,
): Promise<OwnerCalendarData> {
  const admin = createAdminClient();

  const [assignmentsRes, workersRes, projectsRes, unavailRes] = await Promise.all([
    admin
      .from('project_assignments')
      .select('id, project_id, worker_profile_id, scheduled_date')
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
      .select('id, name, status, customers:customer_id (name)')
      .eq('tenant_id', tenantId)
      .is('deleted_at', null),
    admin
      .from('worker_unavailability')
      .select('worker_profile_id, unavailable_date, reason_tag')
      .eq('tenant_id', tenantId)
      .gte('unavailable_date', startDate)
      .lte('unavailable_date', endDate),
  ]);

  if (assignmentsRes.error) throw new Error(assignmentsRes.error.message);
  if (workersRes.error) throw new Error(workersRes.error.message);
  if (projectsRes.error) throw new Error(projectsRes.error.message);
  if (unavailRes.error) throw new Error(unavailRes.error.message);

  const assignments = (assignmentsRes.data ?? []).map((r) => ({
    id: r.id as string,
    project_id: r.project_id as string,
    worker_profile_id: r.worker_profile_id as string,
    scheduled_date: r.scheduled_date as string,
  }));

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
      status: p.status as string,
      customer_name: (customer?.name as string | undefined) ?? null,
    };
  });

  const unavailability: CalendarUnavailability[] = (unavailRes.data ?? []).map((u) => ({
    worker_profile_id: u.worker_profile_id as string,
    unavailable_date: u.unavailable_date as string,
    reason_tag: u.reason_tag as string,
  }));

  return { assignments, projects, workers, unavailability };
}
