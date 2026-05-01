import { notFound } from 'next/navigation';
import { ChangeOrderDetail } from '@/components/features/change-orders/change-order-detail';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { getChangeOrder, listChangeOrderLines } from '@/lib/db/queries/change-orders';
import { getProject } from '@/lib/db/queries/projects';
import { createAdminClient } from '@/lib/supabase/admin';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string; coId: string }>;
}) {
  const { coId } = await params;
  const co = await getChangeOrder(coId);
  return {
    title: co ? `${co.title} — Change Order — HeyHenry` : 'Change Order — HeyHenry',
  };
}

export default async function ChangeOrderDetailPage({
  params,
}: {
  params: Promise<{ id: string; coId: string }>;
}) {
  const { id, coId } = await params;
  const [project, changeOrder] = await Promise.all([getProject(id), getChangeOrder(coId)]);

  if (!project || !changeOrder) notFound();

  // For v2 COs, load the line-level diff so the detail view can render
  // before/after per line. v1 COs (flow_version=1) keep the breakdown view.
  const diffLines =
    changeOrder.flow_version === 2 ? await listChangeOrderLines(changeOrder.id) : [];

  // Sign any manual-approval proof attachments so the detail view can
  // render clickable links without exposing the raw storage paths.
  const proofSignedUrls: Record<string, string> = {};
  const proofPaths = changeOrder.approval_proof_paths ?? [];
  if (proofPaths.length > 0) {
    const admin = createAdminClient();
    const { data } = await admin.storage.from('approval-proofs').createSignedUrls(proofPaths, 3600);
    for (const row of data ?? []) {
      if (row.path && row.signedUrl) proofSignedUrls[row.path] = row.signedUrl;
    }
  }

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="mb-4">
        <DetailPageNav homeHref={`/projects/${id}?tab=budget`} homeLabel="Project budget" />
      </div>

      <ChangeOrderDetail
        changeOrder={changeOrder}
        projectId={id}
        proofSignedUrls={proofSignedUrls}
        budgetCategoryNamesById={Object.fromEntries(
          project.budget_categories.map((b) => [b.id, b.name]),
        )}
        diffLines={diffLines}
      />
    </div>
  );
}
