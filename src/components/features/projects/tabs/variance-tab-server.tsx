import { VarianceTab } from '@/components/features/projects/variance-tab';
import { getVarianceReport } from '@/lib/db/queries/cost-lines';
import { getProject } from '@/lib/db/queries/projects';

export default async function VarianceTabServer({ projectId }: { projectId: string }) {
  const [variance, project] = await Promise.all([
    getVarianceReport(projectId),
    getProject(projectId),
  ]);
  return <VarianceTab variance={variance} lifecycleStage={project?.lifecycle_stage} />;
}
