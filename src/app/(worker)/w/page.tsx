import { Clock } from 'lucide-react';
import Link from 'next/link';
import { SiteSwitcher } from '@/components/features/checklist/site-switcher';
import { TeamChecklist } from '@/components/features/checklist/team-checklist';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireWorker } from '@/lib/auth/helpers';
import { listProjectsForWorker } from '@/lib/db/queries/project-assignments';
import { getLastBilledProjectForWorker } from '@/lib/db/queries/project-checklist';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function WorkerTodayPage({
  searchParams,
}: {
  searchParams?: Promise<{ project?: string }>;
}) {
  const { user, tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const params = (await searchParams) ?? {};

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
  const todayLabel = new Date(`${today}T00:00`).toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const profileIncomplete =
    !profile.display_name ||
    !profile.phone ||
    (profile.worker_type === 'subcontractor' && !profile.gst_number);

  // Today's projects: day-scheduled rows matching today + all ongoing.
  const admin = createAdminClient();
  const { data: todayRows } = await admin
    .from('project_assignments')
    .select('project_id, scheduled_date, projects:project_id (name)')
    .eq('tenant_id', tenant.id)
    .eq('worker_profile_id', profile.id)
    .or(`scheduled_date.eq.${today},scheduled_date.is.null`);

  type TodayRow = {
    project_id: string;
    project_name: string;
    scheduled: boolean;
  };
  const seen = new Set<string>();
  const todaysProjects: TodayRow[] = [];
  for (const r of (todayRows ?? []) as unknown as Array<Record<string, unknown>>) {
    const pid = r.project_id as string;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const proj = r.projects as { name?: string } | { name?: string }[] | null;
    const p = Array.isArray(proj) ? proj[0] : proj;
    todaysProjects.push({
      project_id: pid,
      project_name: p?.name ?? 'Project',
      scheduled: (r.scheduled_date as string | null) === today,
    });
  }
  // Scheduled first, then ongoing.
  todaysProjects.sort((a, b) => Number(b.scheduled) - Number(a.scheduled));

  const allProjects = await listProjectsForWorker(tenant.id, profile.id);

  // Pick the project for the team checklist widget. Priority:
  //   1. ?project= URL param (explicit switch)
  //   2. Most recent project the worker logged time against
  //   3. Today's first scheduled/ongoing project
  // Whatever we land on must still be in the worker's assigned set.
  const assignedIds = new Set(allProjects.map((p) => p.project_id));
  let activeSite: {
    project_id: string;
    project_name: string;
    customer_name: string | null;
  } | null = null;

  if (params.project && assignedIds.has(params.project)) {
    const match = allProjects.find((p) => p.project_id === params.project);
    if (match) {
      activeSite = {
        project_id: match.project_id,
        project_name: match.project_name,
        customer_name: match.customer_name,
      };
    }
  }

  if (!activeSite) {
    const last = await getLastBilledProjectForWorker(user.id);
    if (last && assignedIds.has(last.project_id)) {
      const match = allProjects.find((p) => p.project_id === last.project_id);
      if (match) {
        activeSite = {
          project_id: match.project_id,
          project_name: match.project_name,
          customer_name: match.customer_name,
        };
      }
    }
  }

  if (!activeSite && todaysProjects.length > 0) {
    const first = todaysProjects[0];
    const match = allProjects.find((p) => p.project_id === first.project_id);
    if (match) {
      activeSite = {
        project_id: match.project_id,
        project_name: match.project_name,
        customer_name: match.customer_name,
      };
    }
  }

  const switcherOptions = allProjects.map((p) => ({
    project_id: p.project_id,
    project_name: p.project_name,
    customer_name: p.customer_name,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-muted-foreground">{todayLabel}</p>
        <h1 className="text-2xl font-semibold">
          Hi{profile.display_name ? `, ${profile.display_name.split(' ')[0]}` : ''}.
        </h1>
      </div>

      {profileIncomplete ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Finish setting up your profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Add your name, phone number
              {profile.worker_type === 'subcontractor' ? ', and GST number' : ''} so your time and
              invoices are tagged correctly.
            </p>
            <Link
              href="/w/profile"
              className="inline-flex items-center rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background"
            >
              Open profile
            </Link>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Today&apos;s schedule</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {todaysProjects.length === 0 ? (
            <p className="text-muted-foreground">
              No projects scheduled for today. You can still log time against any project
              you&apos;re on.
            </p>
          ) : (
            todaysProjects.map((p) => (
              <div
                key={p.project_id}
                className="flex items-center justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0">
                  <Link
                    href={`/w/projects/${p.project_id}`}
                    className="block truncate text-sm font-medium"
                  >
                    {p.project_name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {p.scheduled ? 'Scheduled today' : 'Ongoing'}
                  </p>
                </div>
                <Button asChild size="sm" variant="secondary">
                  <Link href={`/w/time/new?project=${p.project_id}&date=${today}`}>
                    <Clock className="size-4" /> Log time
                  </Link>
                </Button>
              </div>
            ))
          )}
          {todaysProjects.length === 0 && allProjects.length > 0 ? (
            <Button asChild size="sm" className="mt-2 w-full" variant="outline">
              <Link href="/w/time/new">
                <Clock className="size-4" /> Log time
              </Link>
            </Button>
          ) : null}
        </CardContent>
      </Card>

      {activeSite ? (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-baseline justify-between gap-2">
              <CardTitle className="text-base">Team checklist</CardTitle>
              <SiteSwitcher current={activeSite} options={switcherOptions} basePath="/w" />
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <TeamChecklist
              key={activeSite.project_id}
              projectId={activeSite.project_id}
              projectName={activeSite.project_name}
              chrome="bare"
            />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
