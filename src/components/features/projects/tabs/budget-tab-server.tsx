import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';

export default async function BudgetTabServer({ projectId }: { projectId: string }) {
  const [budget, costLines, catalog] = await Promise.all([
    getBudgetVsActual(projectId),
    listCostLines(projectId),
    listMaterialsCatalog(),
  ]);

  return (
    <BudgetCategoriesTable
      lines={budget.lines}
      projectId={projectId}
      costLines={costLines}
      catalog={catalog}
    />
  );
}
