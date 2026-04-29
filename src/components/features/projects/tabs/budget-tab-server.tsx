import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getProject } from '@/lib/db/queries/projects';

export default async function BudgetTabServer({ projectId }: { projectId: string }) {
  const [budget, costLines, catalog, project, coContributions] = await Promise.all([
    getBudgetVsActual(projectId),
    listCostLines(projectId),
    listMaterialsCatalog(),
    getProject(projectId),
    getProjectChangeOrderContributions(projectId),
  ]);

  return (
    <BudgetCategoriesTable
      lines={budget.lines}
      projectId={projectId}
      costLines={costLines}
      catalog={catalog}
      estimateStatus={project?.estimate_status ?? 'draft'}
      coContributionsByCategoryId={Object.fromEntries(coContributions.byCategoryId)}
    />
  );
}
