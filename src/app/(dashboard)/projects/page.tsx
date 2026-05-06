import { Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { AwaitingApprovalList } from '@/components/features/projects/awaiting-approval-list';
import { ProjectTabs } from '@/components/features/projects/project-tabs';
import { ProjectsTable } from '@/components/features/projects/projects-table';
import { Button } from '@/components/ui/button';
import { getProjectsAwaitingApproval } from '@/lib/db/queries/awaiting-approval';
import { listProjectProgress } from '@/lib/db/queries/cost-lines';
import { listCustomers } from '@/lib/db/queries/customers';
import { countProjectsByLifecycleStage, listProjects } from '@/lib/db/queries/projects';
import type { LifecycleStage } from '@/lib/validators/project';

export const metadata = {
  title: 'Projects — HeyHenry',
};

type ViewKey = 'all' | 'awaiting_approval' | 'active' | 'complete';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseView(value: string | string[] | undefined): ViewKey {
  if (value === 'active' || value === 'complete' || value === 'awaiting_approval') return value;
  return 'all';
}

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const resolved = await searchParams;
  const view = parseView(resolved.view);

  const [projects, counts, awaitingApproval, allCustomers] = await Promise.all([
    listProjects({ limit: 200 }),
    countProjectsByLifecycleStage(),
    // Always fetch — we need the count for the tab label even on other tabs.
    getProjectsAwaitingApproval(),
    listCustomers({ limit: 500 }),
  ]);
  const customerOptions = allCustomers.map((c) => ({ id: c.id, name: c.name }));
  // "All" excludes on_hold by default so paused jobs don't clutter the list.
  // Dedicated filter can surface them later if JVD asks.
  const total =
    counts.planning +
    counts.awaiting_approval +
    counts.active +
    counts.declined +
    counts.complete +
    counts.cancelled;
  const active = counts.active;

  // Active tab = estimate-approved work actually happening. Planning and
  // awaiting_approval have their own surfaces; on_hold / declined / cancelled
  // are excluded.
  const filtered =
    view === 'active'
      ? projects.filter((p) => p.lifecycle_stage === 'active')
      : view === 'complete'
        ? projects.filter((p) => p.lifecycle_stage === 'complete')
        : projects.filter((p) => p.lifecycle_stage !== 'on_hold');

  // Batch-fetch derived progress (work status + cost burn) for visible rows.
  const progress = await listProjectProgress(filtered.map((p) => p.id));

  const tabCounts = {
    all: total,
    awaiting_approval: awaitingApproval.length,
    active,
    complete: counts.complete,
  };

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            {total === 0 ? 'No projects yet.' : `${active} active · ${counts.complete} complete`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/projects/import">
              <Sparkles className="size-3.5" />
              Import with Henry
            </Link>
          </Button>
          <Button asChild>
            <Link href="/projects/new">
              <Plus className="size-3.5" />
              New project
            </Link>
          </Button>
        </div>
      </header>

      {total > 0 && (
        <Suspense fallback={null}>
          <ProjectTabs counts={tabCounts} />
        </Suspense>
      )}

      {view === 'awaiting_approval' ? (
        <AwaitingApprovalList projects={awaitingApproval} variant="full" />
      ) : filtered.length === 0 ? (
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
        <ProjectsTable
          projects={filtered.map((p) => {
            const prog = progress.get(p.id);
            return {
              id: p.id,
              name: p.name,
              lifecycle_stage: p.lifecycle_stage as LifecycleStage,
              start_date: p.start_date,
              work_status_pct: prog?.workStatusPct ?? 0,
              cost_burn_pct: prog?.costBurnPct ?? 0,
              customer: p.customer ? { id: p.customer.id, name: p.customer.name } : null,
            };
          })}
          customerOptions={customerOptions}
        />
      )}
    </div>
  );
}
