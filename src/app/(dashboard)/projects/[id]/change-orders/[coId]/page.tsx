import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderDetail } from '@/components/features/change-orders/change-order-detail';
import { getChangeOrder } from '@/lib/db/queries/change-orders';
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
      <Link
        href={`/projects/${id}?tab=change-orders`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Change Orders
      </Link>

      <ChangeOrderDetail
        changeOrder={changeOrder}
        projectId={id}
        proofSignedUrls={proofSignedUrls}
        budgetCategoryNamesById={Object.fromEntries(
          project.budget_categories.map((b) => [b.id, b.name]),
        )}
      />
    </div>
  );
}
