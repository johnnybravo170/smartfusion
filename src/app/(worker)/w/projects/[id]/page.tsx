import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TeamChecklist } from '@/components/features/checklist/team-checklist';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireWorker } from '@/lib/auth/helpers';
import {
  isWorkerAssignedToProject,
  listAssignmentsForProject,
} from '@/lib/db/queries/project-assignments';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function WorkerProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const assigned = await isWorkerAssignedToProject(tenant.id, profile.id, id);
  if (!assigned) notFound();

  const admin = createAdminClient();
  const { data: project } = await admin
    .from('projects')
    .select(
      'id, tenant_id, name, status, target_end_date, description, customers:customer_id (name, address)',
    )
    .eq('id', id)
    .eq('tenant_id', tenant.id)
    .is('deleted_at', null)
    .single();

  if (!project) notFound();

  const { data: categories } = await admin
    .from('project_budget_categories')
    .select('id, name, section, description')
    .eq('project_id', id)
    .order('display_order', { ascending: true });

  const assignments = await listAssignmentsForProject(tenant.id, id);
  const myAssignments = assignments.filter((a) => a.worker_profile_id === profile.id);
  const myUpcoming = myAssignments
    .filter((a) => a.scheduled_date && a.scheduled_date >= new Date().toISOString().slice(0, 10))
    .sort((a, b) => (a.scheduled_date ?? '').localeCompare(b.scheduled_date ?? ''));

  const customersRaw = project.customers as
    | { name?: string; address?: string }
    | { name?: string; address?: string }[]
    | null;
  const customer = Array.isArray(customersRaw) ? customersRaw[0] : customersRaw;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/w/projects"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-3.5" /> Projects
      </Link>

      <div>
        <h1 className="text-2xl font-semibold">{project.name as string}</h1>
        {customer?.name ? <p className="text-sm text-muted-foreground">{customer.name}</p> : null}
        {customer?.address ? (
          <p className="text-xs text-muted-foreground">{customer.address}</p>
        ) : null}
      </div>

      {myUpcoming.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your scheduled days</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {myUpcoming.map((a) => (
              <p key={a.id}>
                {a.scheduled_date
                  ? new Intl.DateTimeFormat('en-CA', {
                      timeZone: tenant.timezone,
                      weekday: 'long',
                      month: 'short',
                      day: 'numeric',
                    }).format(new Date(`${a.scheduled_date}T00:00`))
                  : ''}
                {a.notes ? <span className="ml-2 text-muted-foreground">{a.notes}</span> : null}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {project.description ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Scope</CardTitle>
          </CardHeader>
          <CardContent className="whitespace-pre-wrap text-sm">
            {project.description as string}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Work areas</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {(categories ?? []).length === 0 ? (
            <p className="text-muted-foreground">No work areas defined yet.</p>
          ) : (
            (categories ?? []).map((b) => (
              <div key={b.id as string}>
                <p className="font-medium">{b.name as string}</p>
                {b.description ? (
                  <p className="text-xs text-muted-foreground">{b.description as string}</p>
                ) : null}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <TeamChecklist projectId={id} projectName={project.name as string} />
    </div>
  );
}
