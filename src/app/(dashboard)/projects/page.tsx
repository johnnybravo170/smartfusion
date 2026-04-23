import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { ProjectNameEditor } from '@/components/features/projects/project-name-editor';
import { ProjectStatusBadge } from '@/components/features/projects/project-status-badge';
import { ProjectTabs } from '@/components/features/projects/project-tabs';
import { Button } from '@/components/ui/button';
import { countProjectsByStatus, listProjects } from '@/lib/db/queries/projects';
import type { ProjectStatus } from '@/lib/validators/project';

export const metadata = {
  title: 'Projects — HeyHenry',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseView(value: string | string[] | undefined): 'active' | 'complete' | 'all' {
  if (value === 'active' || value === 'complete') return value;
  return 'all';
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const resolved = await searchParams;
  const view = parseView(resolved.view);

  const [projects, counts] = await Promise.all([
    listProjects({ limit: 200 }),
    countProjectsByStatus(),
  ]);
  const total = counts.planning + counts.in_progress + counts.complete + counts.cancelled;
  const active = counts.planning + counts.in_progress;

  const filtered =
    view === 'active'
      ? projects.filter((p) => p.status === 'planning' || p.status === 'in_progress')
      : view === 'complete'
        ? projects.filter((p) => p.status === 'complete')
        : projects;

  const tabCounts = { all: total, active, complete: counts.complete };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {total === 0 ? 'No projects yet.' : `${active} active · ${counts.complete} complete`}
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus className="size-3.5" />
            New project
          </Link>
        </Button>
      </header>

      {total > 0 && (
        <Suspense fallback={null}>
          <ProjectTabs counts={tabCounts} />
        </Suspense>
      )}

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-muted-foreground">
            Create your first renovation project to get started.
          </p>
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="mr-1 size-3.5" />
              New project
            </Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Project</th>
                <th className="px-4 py-3 text-left font-medium">Customer</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="px-4 py-3 text-left font-medium">Start</th>
                <th className="px-4 py-3 text-right font-medium">Complete</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => (
                <tr key={p.id} className="group border-b last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1">
                      <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                        {p.name}
                      </Link>
                      <ProjectNameEditor projectId={p.id} name={p.name} variant="inline" />
                    </span>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.customer ? (
                      <Link href={`/customers/${p.customer.id}`} className="hover:underline">
                        {p.customer.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <ProjectStatusBadge status={p.status as ProjectStatus} />
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {p.start_date
                      ? new Date(p.start_date).toLocaleDateString('en-CA', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </td>
                  <td className="px-4 py-3 text-right">{p.percent_complete}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
