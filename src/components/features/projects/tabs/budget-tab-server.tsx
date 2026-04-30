import Link from 'next/link';
import { AppliedChangeOrdersBanner } from '@/components/features/change-orders/applied-co-banner';
import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import {
  type BudgetMode,
  BudgetModeToggle,
} from '@/components/features/projects/budget-mode-toggle';
import { EstimateSentBanner } from '@/components/features/projects/estimate-sent-banner';
import { HenryInsightStrip } from '@/components/features/projects/henry-insight-strip';
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

  return (
    <div className="flex flex-col gap-3">
      <EstimateSentBanner
        estimateStatus={estimateStatus}
        sentAt={(project?.estimate_sent_at as string | null) ?? null}
        customerName={project?.customer?.name ?? null}
        approvalCode={(project?.estimate_approval_code as string | null) ?? null}
      />
      <AppliedChangeOrdersBanner
        appliedCount={coContributions.appliedOrder.length}
        projectId={projectId}
        versions={versions}
      />

      {/* Mode toggle — large, prominent, anchored at the top of the
          tab so the operator always knows which posture they're in.
          Editing = authoring; Executing = tracking. Each posture
          shows different columns + different action density (see
          BudgetCategoriesTable). */}
      <BudgetModeToggle currentMode={mode} />

      {/* Mode-specific actions row — only renders when there's
          something to act on. Subordinate to the mode toggle above. */}
      {(mode === 'editing' && (sendable || !isEmptyScope)) || mode === 'executing' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {mode === 'editing'
              ? 'Build the scope. Send to the customer when ready.'
              : 'Track actuals against the signed estimate. Edits flow through change orders.'}
          </span>
          <div className="flex items-center gap-2">
            {mode === 'editing' && !isEmptyScope ? (
              <SaveAsTemplateButton projectId={projectId} />
            ) : null}
            {mode === 'editing' && sendable ? (
              <Button asChild size="sm">
                <Link href={`/projects/${projectId}/estimate/preview`}>Send for approval</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {showStarterPicker ? (
        <>
          <ScopeScaffoldGenerator projectId={projectId} />
          <StarterTemplatePicker projectId={projectId} />
        </>
      ) : null}

      {/* Henry insight strip — Executing mode only. Reads variance +
          diff signals, surfaces up to 2 actionable observations as
          clickable rows. Hidden in Editing mode where the operator is
          authoring scope, not tracking status. */}
      {mode === 'executing' ? <HenryInsightStrip projectId={projectId} /> : null}

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
