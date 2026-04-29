/**
 * Project Overview tab — split into per-section async components so each
 * piece streams independently. The variance card is by far the heaviest
 * (variance + CO contributions) and used to block the entire tab; now the
 * facts grid + timeline can paint while it's still loading.
 *
 * Skeletons are lightweight on purpose — see TabSkeleton for the rationale.
 */

import { Suspense } from 'react';
import { VarianceTab } from '@/components/features/projects/budget-summary';
import { ProjectTimeline } from '@/components/features/projects/project-timeline';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { getVarianceReport } from '@/lib/db/queries/cost-lines';
import { listProjectEvents } from '@/lib/db/queries/project-events';
import { getProject } from '@/lib/db/queries/projects';

export default function OverviewTabServer({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-6">
      <Suspense fallback={<VarianceSkeleton />}>
        <VarianceSection projectId={projectId} />
      </Suspense>

      <Suspense fallback={<FactsGridSkeleton />}>
        <ProjectFactsSection projectId={projectId} />
      </Suspense>

      <Suspense fallback={<TimelineSkeleton />}>
        <TimelineSection projectId={projectId} />
      </Suspense>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

async function VarianceSection({ projectId }: { projectId: string }) {
  const [project, variance, coContributions] = await Promise.all([
    getProject(projectId),
    getVarianceReport(projectId),
    getProjectChangeOrderContributions(projectId),
  ]);
  if (!project) return null;
  return (
    <VarianceTab
      variance={variance}
      lifecycleStage={project.lifecycle_stage}
      projectId={projectId}
      appliedChangeOrders={coContributions.appliedOrder}
      allChangeOrders={coContributions.all}
    />
  );
}

async function ProjectFactsSection({ projectId }: { projectId: string }) {
  // getProject is React.cache-wrapped, so this dedupes against the
  // VarianceSection call above when both run in the same request.
  const project = await getProject(projectId);
  if (!project) return null;
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground">Start Date</p>
        <p className="text-sm font-medium">
          {project.start_date
            ? new Date(project.start_date).toLocaleDateString('en-CA', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Not set'}
        </p>
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground">Target End</p>
        <p className="text-sm font-medium">
          {project.target_end_date
            ? new Date(project.target_end_date).toLocaleDateString('en-CA', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : 'Not set'}
        </p>
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground">Mgmt Fee</p>
        <p className="text-sm font-medium">{Math.round(project.management_fee_rate * 100)}%</p>
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs text-muted-foreground">Categories</p>
        <p className="text-sm font-medium">{project.budget_categories.length}</p>
      </div>
    </div>
  );
}

async function TimelineSection({ projectId }: { projectId: string }) {
  const projectEvents = await listProjectEvents(projectId);
  return <ProjectTimeline events={projectEvents} />;
}

// ---------------------------------------------------------------------------
// Skeletons
// ---------------------------------------------------------------------------

function VarianceSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-12 rounded-md bg-muted/60" />
      <div className="h-40 rounded-md bg-muted/60" />
      <div className="h-32 rounded-md bg-muted/60" />
    </div>
  );
}

function FactsGridSkeleton() {
  return (
    <div className="grid animate-pulse grid-cols-2 gap-4 md:grid-cols-4">
      <div className="h-16 rounded-lg bg-muted/60" />
      <div className="h-16 rounded-lg bg-muted/60" />
      <div className="h-16 rounded-lg bg-muted/60" />
      <div className="h-16 rounded-lg bg-muted/60" />
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="animate-pulse space-y-2">
      <div className="h-6 w-32 rounded bg-muted/60" />
      <div className="h-24 rounded-md bg-muted/60" />
    </div>
  );
}
