import { VarianceTab } from '@/components/features/projects/budget-summary';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { getVarianceReport } from '@/lib/db/queries/cost-lines';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getProject } from '@/lib/db/queries/projects';

export default async function VarianceTabServer({ projectId }: { projectId: string }) {
  const [variance, project, coContributions, budget] = await Promise.all([
    getVarianceReport(projectId),
    getProject(projectId),
    getProjectChangeOrderContributions(projectId),
    getBudgetVsActual(projectId),
  ]);

  // Map category name -> id so VarianceTab can attach CO chips by name.
  const categoryIdByName: Record<string, string> = {};
  for (const l of budget.lines) {
    categoryIdByName[l.budget_category_name] = l.budget_category_id;
  }

  return (
    <VarianceTab
      variance={variance}
      lifecycleStage={project?.lifecycle_stage}
      projectId={projectId}
      appliedChangeOrders={coContributions.appliedOrder}
      coContributionsByCategoryId={Object.fromEntries(coContributions.byCategoryId)}
      categoryIdByName={categoryIdByName}
    />
  );
}
