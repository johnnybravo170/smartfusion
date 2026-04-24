import { EstimateTab } from '@/components/features/projects/estimate-tab';
import { EstimateTermsEditor } from '@/components/features/projects/estimate-terms-editor';
import { ProjectDocumentTypeToggle } from '@/components/features/projects/project-document-type-toggle';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { listEstimateSnippets } from '@/lib/db/queries/estimate-snippets';
import { listMaterialsCatalog } from '@/lib/db/queries/materials-catalog';
import { listBucketsForProject } from '@/lib/db/queries/project-buckets';
import { getEstimateViewStats } from '@/lib/db/queries/project-events';
import { getProject } from '@/lib/db/queries/projects';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export default async function EstimateTabServer({ projectId }: { projectId: string }) {
  const [project, costLines, catalog, projectBuckets, estimateViewStats, snippets] =
    await Promise.all([
      getProject(projectId),
      listCostLines(projectId),
      listMaterialsCatalog(),
      listBucketsForProject(projectId),
      getEstimateViewStats(projectId),
      listEstimateSnippets(),
    ]);
  if (!project) return null;

  // Sign any manual-override proof files so the tab can link to them.
  const proofSignedUrls: Record<string, string> = {};
  const proofPaths = project.estimate_approval_proof_paths ?? [];
  if (proofPaths.length > 0) {
    const adminForProofs = createAdminClient();
    const { data: signed } = await adminForProofs.storage
      .from('approval-proofs')
      .createSignedUrls(proofPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) proofSignedUrls[row.path] = row.signedUrl;
    }
  }

  const bucketsById: Record<string, { name: string; section: string | null; order: number }> = {};
  for (const b of projectBuckets) {
    bucketsById[b.id] = { name: b.name, section: b.section ?? null, order: b.display_order };
  }

  // Customer feedback + cost-line photo URLs (signed via admin so storage
  // RLS doesn't silently return empty).
  const supabase = await createClient();
  const { data: feedbackRowsRaw } = await supabase
    .from('project_estimate_comments')
    .select('id, body, cost_line_id, seen_at, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });
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

  const costLinePhotoUrls: Record<string, string> = {};
  const costLinePhotoPaths = Array.from(
    new Set(costLines.flatMap((l) => l.photo_storage_paths ?? [])),
  );
  if (costLinePhotoPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(costLinePhotoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) costLinePhotoUrls[row.path] = row.signedUrl;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-3 rounded-xl border bg-card px-4 py-2">
        <ProjectDocumentTypeToggle projectId={projectId} initialValue={project.document_type} />
      </div>
      <EstimateTab
        projectId={projectId}
        costLines={costLines}
        catalog={catalog}
        costLinePhotoUrls={costLinePhotoUrls}
        managementFeeRate={project.management_fee_rate}
        feedback={feedbackRows}
        bucketsById={bucketsById}
        approval={{
          status: project.estimate_status,
          approval_code: project.estimate_approval_code,
          sent_at: project.estimate_sent_at,
          approved_at: project.estimate_approved_at,
          approved_by_name: project.estimate_approved_by_name,
          declined_at: project.estimate_declined_at,
          declined_reason: project.estimate_declined_reason,
          view_count: estimateViewStats.total,
          last_viewed_at: estimateViewStats.last_viewed_at,
          approval_method: project.estimate_approval_method ?? null,
          approval_notes: project.estimate_approval_notes ?? null,
          approval_proof_paths: project.estimate_approval_proof_paths ?? [],
          approval_proof_signed_urls: proofSignedUrls,
        }}
      />
      <EstimateTermsEditor
        projectId={projectId}
        initialTermsText={project.terms_text}
        snippets={snippets}
      />
    </div>
  );
}
