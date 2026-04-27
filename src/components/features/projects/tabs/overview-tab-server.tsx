import { ProjectTimeline } from '@/components/features/projects/project-timeline';
import { VarianceTab } from '@/components/features/projects/variance-tab';
import { getVarianceReport } from '@/lib/db/queries/cost-lines';
import { listProjectEvents } from '@/lib/db/queries/project-events';
import { getProject } from '@/lib/db/queries/projects';

export default async function OverviewTabServer({ projectId }: { projectId: string }) {
  const [project, variance, projectEvents] = await Promise.all([
    getProject(projectId),
    getVarianceReport(projectId),
    listProjectEvents(projectId),
  ]);
  if (!project) return null;

  return (
    <div className="space-y-6">
      {/* Variance is the headline "are we on track?" view. Used to live on
          its own tab — merged in 2026-04-27 to remove a redundant click. */}
      <VarianceTab variance={variance} />

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
          <p className="text-sm font-medium">{project.cost_buckets.length}</p>
        </div>
      </div>

      <ProjectTimeline events={projectEvents} />
    </div>
  );
}
