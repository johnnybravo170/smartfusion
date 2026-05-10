import Link from 'next/link';
import { AppliedChangeOrdersBanner } from '@/components/features/change-orders/applied-co-banner';
import { BudgetCategoriesTable } from '@/components/features/projects/budget-categories-table';
import { EstimateApprovalActions } from '@/components/features/projects/estimate-approval-actions';
import { EstimateFeedbackCard } from '@/components/features/projects/estimate-feedback-card';
import { EstimateSentBanner } from '@/components/features/projects/estimate-sent-banner';
import { EstimateTermsEditor } from '@/components/features/projects/estimate-terms-editor';
import { ProjectDocumentTypeToggle } from '@/components/features/projects/project-document-type-toggle';
import { SaveAsTemplateButton } from '@/components/features/projects/save-as-template-button';
import { ScopeScaffoldGenerator } from '@/components/features/projects/scope-scaffold-generator';
import { StarterTemplatePicker } from '@/components/features/projects/starter-template-picker';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getProjectChangeOrderContributions } from '@/lib/db/queries/change-orders';
import { getCostLineActualsByProject } from '@/lib/db/queries/cost-line-actuals';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listEstimateSnippets } from '@/lib/db/queries/estimate-snippets';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getEstimateViewStats } from '@/lib/db/queries/project-events';
import { listProjectVersions } from '@/lib/db/queries/project-versions';
import { getProject } from '@/lib/db/queries/projects';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
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
  const supabase = await createClient();
  const [
    budget,
    costLines,
    catalog,
    project,
    coContributions,
    versions,
    actualsByLineId,
    tenant,
    viewStats,
    snippets,
    { data: feedbackRowsRaw },
  ] = await Promise.all([
    getBudgetVsActual(projectId),
    listCostLines(projectId),
    listMaterialsCatalog(),
    getProject(projectId),
    getProjectChangeOrderContributions(projectId),
    listProjectVersions(projectId),
    getCostLineActualsByProject(projectId),
    getCurrentTenant(),
    getEstimateViewStats(projectId),
    listEstimateSnippets(),
    supabase
      .from('project_estimate_comments')
      .select('id, body, cost_line_id, seen_at, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
  ]);

  // Sign manual-approval proof files so the approval card can link to
  // them. Storage bucket is private; admin client because operator
  // session may not have direct access. Empty when no manual override.
  const proofPaths = project?.estimate_approval_proof_paths ?? [];
  const proofSignedUrls: Record<string, string> = {};
  if (proofPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('approval-proofs')
      .createSignedUrls(proofPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) proofSignedUrls[row.path] = row.signedUrl;
    }
  }

  // Resolve cost-line labels for any line-targeted comments so the
  // operator sees "Re: Demolition" instead of a UUID.
  const costLineLabelById = new Map(costLines.map((l) => [l.id, l.label]));
  const feedbackRows = (feedbackRowsRaw ?? []).map((r) => ({
    id: r.id as string,
    body: r.body as string,
    cost_line_id: (r.cost_line_id as string | null) ?? null,
    cost_line_label: r.cost_line_id
      ? (costLineLabelById.get(r.cost_line_id as string) ?? null)
      : null,
    seen_at: (r.seen_at as string | null) ?? null,
    created_at: r.created_at as string,
  }));

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
        timezone={tenant?.timezone ?? 'America/Vancouver'}
        viewStats={viewStats}
      />

      <EstimateFeedbackCard projectId={projectId} feedback={feedbackRows} />

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

      {/* Approval-state actions: declined banner, manual-override metadata, */}
      {/* and the action button row (Mark approved/declined, Reset, Copy */}
      {/* link, Preview, Create invoice). Self-hides on a fresh draft. */}
      {project ? (
        <EstimateApprovalActions
          projectId={projectId}
          status={estimateStatus}
          approvalCode={(project.estimate_approval_code as string | null) ?? null}
          approvedByName={(project.estimate_approved_by_name as string | null) ?? null}
          approvedAt={(project.estimate_approved_at as string | null) ?? null}
          declinedAt={(project.estimate_declined_at as string | null) ?? null}
          declinedReason={(project.estimate_declined_reason as string | null) ?? null}
          approvalMethod={(project.estimate_approval_method as string | null) ?? null}
          approvalNotes={(project.estimate_approval_notes as string | null) ?? null}
          approvalProofPaths={project.estimate_approval_proof_paths ?? []}
          approvalProofSignedUrls={proofSignedUrls}
          costLineCount={costLines.length}
        />
      ) : null}

      {hasActionRow ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {showSendForApproval ? (
            <Button asChild size="sm">
              <Link href={`/projects/${projectId}/estimate/preview`}>
                Preview &amp; send to customer
              </Link>
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

      {project ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-3 rounded-xl border bg-card px-4 py-2">
            <ProjectDocumentTypeToggle projectId={projectId} initialValue={project.document_type} />
          </div>
          <EstimateTermsEditor
            projectId={projectId}
            initialTermsText={project.terms_text}
            snippets={snippets}
          />
        </>
      ) : null}
    </div>
  );
}
