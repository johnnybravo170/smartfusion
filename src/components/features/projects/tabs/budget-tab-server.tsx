import Link from 'next/link';
import { AppliedChangeOrdersBanner } from '@/components/features/change-orders/applied-co-banner';
import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import { EstimateSentBanner } from '@/components/features/projects/estimate-sent-banner';
import { SaveAsTemplateButton } from '@/components/features/projects/save-as-template-button';
import { ScopeScaffoldGenerator } from '@/components/features/projects/scope-scaffold-generator';
import { StarterTemplatePicker } from '@/components/features/projects/starter-template-picker';
import { Button } from '@/components/ui/button';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { getCostLineActualsByProject } from '@/lib/db/queries/cost-line-actuals';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { listProjectVersions } from '@/lib/db/queries/project-versions';
import { getProject } from '@/lib/db/queries/projects';
import type { LifecycleStage } from '@/lib/validators/project';

/**
 * Unified Budget page. One view — no Editing/Executing toggle.
 * Authoring CTAs (Save as template, Send for approval, Add category)
 * self-gate based on lifecycle + estimate status. Sections default
 * expanded for planning, collapsed for active and beyond, but the
 * operator can toggle freely on a per-row basis.
 *
 * `?expand=all` / `?expand=none` URL overrides honored for muscle
 * memory of the legacy mode toggle.
 *
 * Replaces the old separate Budget + Estimate + Change Orders tabs
 * (per decision 6790ef2b — diff-tracked + intentional-send model).
 */
export default async function BudgetTabServer({
  projectId,
  defaultExpanded,
}: {
  projectId: string;
  /** When true, sections start expanded; when false, collapsed. Page
   * shell derives this from lifecycle (planning → true) and any
   * `?expand=` URL override. */
  defaultExpanded: boolean;
}) {
  const [budget, costLines, catalog, project, coContributions, versions, actualsByLineId] =
    await Promise.all([
      getBudgetVsActual(projectId),
      listCostLines(projectId),
      listMaterialsCatalog(),
      getProject(projectId),
      getProjectChangeOrderContributions(projectId),
      listProjectVersions(projectId),
      getCostLineActualsByProject(projectId),
    ]);

  const stage = (project?.lifecycle_stage ?? 'planning') as LifecycleStage;
  const isPreApproval = stage === 'planning' || stage === 'awaiting_approval';
  const estimateStatus = project?.estimate_status ?? 'draft';
  const sendable = estimateStatus === 'draft' || estimateStatus === 'declined' || isPreApproval;

  // Self-gating CTAs — no mode prop, just project state.
  const isEmptyScope = costLines.length === 0 && budget.lines.length === 0;
  // Show the template picker on every empty project — not just
  // pre-approval. New projects no longer auto-seed default categories,
  // so an empty active project (rare but possible — e.g. a blank
  // project created post-approval for tracking) still benefits from
  // the head-start.
  const showStarterPicker = isEmptyScope;
  const showSaveAsTemplate = !isEmptyScope;
  const showSendForApproval = sendable;
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
      />

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

      <BudgetCategoriesTable
        lines={budget.lines}
        projectId={projectId}
        costLines={costLines}
        catalog={catalog}
        coContributionsByCategoryId={Object.fromEntries(coContributions.byCategoryId)}
        actualsByLineId={Object.fromEntries(actualsByLineId)}
        defaultExpanded={defaultExpanded}
        headerActions={showSaveAsTemplate ? <SaveAsTemplateButton projectId={projectId} /> : null}
      />
    </div>
  );
}
