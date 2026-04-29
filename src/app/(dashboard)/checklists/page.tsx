import { ListChecks } from 'lucide-react';
import Link from 'next/link';
import { TeamChecklist } from '@/components/features/checklist/team-checklist';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireTenant } from '@/lib/auth/helpers';
import { listOpenChecklistRollup } from '@/lib/db/queries/project-checklist';

export const dynamic = 'force-dynamic';

export default async function ChecklistsPage() {
  const { tenant } = await requireTenant();
  const projects = await listOpenChecklistRollup(tenant.id);
  const totalOpen = projects.reduce((acc, p) => acc + p.open_count, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Team checklists</h1>
        <p className="text-sm text-muted-foreground">
          What the crew needs on each site. Anyone on a project can add or check items.
        </p>
      </div>

      {projects.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <ListChecks className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">Nothing open</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              When the crew adds something on a site, it&rsquo;ll show up here grouped by job.
            </p>
            <Link
              href="/projects"
              className="mt-2 inline-flex items-center rounded-md border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Open a project
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {totalOpen} open across {projects.length}{' '}
            {projects.length === 1 ? 'project' : 'projects'}.
          </p>

          {projects.map((p) => (
            <Card key={p.project_id}>
              <CardHeader className="pb-3">
                <div className="flex items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base">
                      <Link href={`/projects/${p.project_id}`} className="hover:underline">
                        {p.project_name}
                      </Link>
                    </CardTitle>
                    {p.customer_name ? (
                      <p className="truncate text-xs text-muted-foreground">{p.customer_name}</p>
                    ) : null}
                  </div>
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {p.open_count} open
                  </span>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <TeamChecklist projectId={p.project_id} chrome="bare" />
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
