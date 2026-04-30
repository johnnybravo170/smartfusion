import Link from 'next/link';
import { AppliedChangeOrdersBanner } from '@/components/features/change-orders/applied-co-banner';
import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import {
  type BudgetMode,
  BudgetModeToggle,
} from '@/components/features/projects/budget-mode-toggle';
import { Button } from '@/components/ui/button';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getProject } from '@/lib/db/queries/projects';
import type { LifecycleStage } from '@/lib/validators/project';

/**
 * Unified Budget page. Two postures via mode toggle:
 *
 *   - Editing  — scope-authoring surface: sections expanded by default,
 *     "Send for approval" CTA prominent. Default for planning /
 *     awaiting_approval lifecycle stages.
 *   - Executing — status-tracking surface: sections collapsed by
 *     default, headline numbers + diff chip up front. Default for
 *     active and beyond.
 *
 * Replaces the old separate Budget + Estimate + Change Orders tabs
 * (per decision 6790ef2b — diff-tracked + intentional-send model).
 * The Estimate + Change Orders tab routes redirect into Budget at the
 * page-level router; the actual page surface unifies here.
 */
export default async function BudgetTabServer({
  projectId,
  mode,
}: {
  projectId: string;
  mode: BudgetMode;
}) {
  const [budget, costLines, catalog, project, coContributions] = await Promise.all([
    getBudgetVsActual(projectId),
    listCostLines(projectId),
    listMaterialsCatalog(),
    getProject(projectId),
    getProjectChangeOrderContributions(projectId),
  ]);

  const stage = (project?.lifecycle_stage ?? 'planning') as LifecycleStage;
  const isPreApproval = stage === 'planning' || stage === 'awaiting_approval';
  const estimateStatus = project?.estimate_status ?? 'draft';
  const sendable = estimateStatus === 'draft' || estimateStatus === 'declined' || isPreApproval;

  return (
    <div className="flex flex-col gap-3">
      <AppliedChangeOrdersBanner
        appliedCount={coContributions.appliedOrder.length}
        projectId={projectId}
      />

      {/* Mode toolbar — toggle on the left, mode-specific actions on
          the right. Sticky at the top of the tab content so it's always
          accessible while scrolling. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-card px-3 py-2">
        <div className="flex items-center gap-3">
          <BudgetModeToggle currentMode={mode} />
          <span className="text-xs text-muted-foreground">
            {mode === 'editing'
              ? 'Build the scope. Send to the customer when ready.'
              : 'Track actuals against the signed estimate. Edits flow through change orders.'}
          </span>
        </div>
        {mode === 'editing' && sendable ? (
          <Button asChild size="sm">
            <Link href={`/projects/${projectId}/estimate/preview`}>Send for approval</Link>
          </Button>
        ) : null}
      </div>

      <BudgetCategoriesTable
        lines={budget.lines}
        projectId={projectId}
        costLines={costLines}
        catalog={catalog}
        estimateStatus={estimateStatus}
        coContributionsByCategoryId={Object.fromEntries(coContributions.byCategoryId)}
        mode={mode}
      />
    </div>
  );
}
