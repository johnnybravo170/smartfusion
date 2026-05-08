import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { requireWorker } from '@/lib/auth/helpers';
import { listProjectsForWorker } from '@/lib/db/queries/project-assignments';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';

export const dynamic = 'force-dynamic';

export default async function WorkerProjectsPage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const projects = await listProjectsForWorker(tenant.id, profile.id);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Projects</h1>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            You aren&apos;t on any projects yet.
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((p) => (
            <Link key={p.project_id} href={`/w/projects/${p.project_id}`}>
              <Card className="transition-colors hover:bg-muted/40">
                <CardContent className="flex flex-col gap-1 py-4">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-medium">{p.project_name}</p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize text-muted-foreground">
                      {p.lifecycle_stage.replace('_', ' ')}
                    </span>
                  </div>
                  {p.customer_name ? (
                    <p className="text-sm text-muted-foreground">{p.customer_name}</p>
                  ) : null}
                  {p.next_scheduled_date ? (
                    <p className="text-xs text-muted-foreground">
                      Next day:{' '}
                      {new Intl.DateTimeFormat('en-CA', {
                        timeZone: tenant.timezone,
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(`${p.next_scheduled_date}T00:00`))}
                    </p>
                  ) : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
