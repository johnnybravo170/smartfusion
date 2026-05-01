import Link from 'next/link';
import { AppliedChangeOrdersBanner } from '@/components/features/change-orders/applied-co-banner';
import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import {
  type BudgetMode,
  BudgetModeToggle,
} from '@/components/features/projects/budget-mode-toggle';
import { EstimateSentBanner } from '@/components/features/projects/estimate-sent-banner';
import { SaveAsTemplateButton } from '@/components/features/projects/save-as-template-button';
import { ScopeScaffoldGenerator } from '@/components/features/projects/scope-scaffold-generator';
import { StarterTemplatePicker } from '@/components/features/projects/starter-template-picker';
import { Button } from '@/components/ui/button';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { listProjectVersions } from '@/lib/db/queries/project-versions';
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
  const [budget, costLines, catalog, project, coContributions, versions] = await Promise.all([
    getBudgetVsActual(projectId),
    listCostLines(projectId),
    listMaterialsCatalog(),
    getProject(projectId),
    getProjectChangeOrderContributions(projectId),
    listProjectVersions(projectId),
  ]);

  const stage = (project?.lifecycle_stage ?? 'planning') as LifecycleStage;
  const isPreApproval = stage === 'planning' || stage === 'awaiting_approval';
  const estimateStatus = project?.estimate_status ?? 'draft';
  const sendable = estimateStatus === 'draft' || estimateStatus === 'declined' || isPreApproval;

  // Show the starter-template picker only when the project is empty
  // and we're in editing posture. Once seeded, the picker disappears.
  const isEmptyScope = costLines.length === 0 && budget.lines.length === 0;
  const showStarterPicker = mode === 'editing' && isEmptyScope && isPreApproval;

  // Right-side actions. Save-as-template is rendered down inside the
  // table's own action row (next to Add category / Generate Estimate)
  // so it lives with the other budget-authoring tools. Send-for-approval
  // stays in its own top-of-tab row — it's a strong CTA that deserves
  // top placement when the estimate is sendable.
  const showSaveAsTemplate = mode === 'editing' && !isEmptyScope;
  const showSendForApproval = mode === 'editing' && sendable;
  const hasActionRow = showSendForApproval;

  return (
    <div className="flex flex-col gap-3">
      <EstimateSentBanner
        estimateStatus={estimateStatus}
        sentAt={(project?.estimate_sent_at as string | null) ?? null}
        customerName={project?.customer?.name ?? null}
        approvalCode={(project?.estimate_approval_code as string | null) ?? null}
      />

      {/* Merged signed-estimate banner. Renders only when the estimate */}
      {/* is approved; absorbs both the legacy "Estimate is approved" */}
      {/* amber block and the "Reflects N applied COs" blue banner that */}
      {/* used to live separately above and inside the table. */}
      <AppliedChangeOrdersBanner
        estimateStatus={estimateStatus}
        appliedCount={coContributions.appliedOrder.length}
        projectId={projectId}
        versions={versions}
        mode={mode}
      />

      {/* Action row — only renders when there's a CTA to surface. */}
      {/* Subtitle text dropped (was redundant with the merged banner */}
      {/* above and the mode toggle below). */}
      {hasActionRow ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showSendForApproval ? (
            <Button asChild size="sm">
              <Link href={`/projects/${projectId}/estimate/preview`}>Send for approval</Link>
            </Button>
          ) : null}
        </div>
      ) : null}

      {showStarterPicker ? (
        <>
          <ScopeScaffoldGenerator projectId={projectId} />
          <StarterTemplatePicker projectId={projectId} />
        </>
      ) : null}

      {/* Mode toggle — anchored right above the table so the operator */}
      {/* knows which posture controls the data they're about to read. */}
      <BudgetModeToggle currentMode={mode} />

      <BudgetCategoriesTable
        lines={budget.lines}
        projectId={projectId}
        costLines={costLines}
        catalog={catalog}
        coContributionsByCategoryId={Object.fromEntries(coContributions.byCategoryId)}
        mode={mode}
        headerActions={showSaveAsTemplate ? <SaveAsTemplateButton projectId={projectId} /> : null}
      />
    </div>
  );
}
