import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderDiffForm } from '@/components/features/change-orders/change-order-diff-form';
import { ChangeOrderForm } from '@/components/features/change-orders/change-order-form';
import { listCostLines } from '@/lib/db/queries/cost-lines';
import { getProject } from '@/lib/db/queries/projects';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  return {
    title: project
      ? `New Change Order — ${project.name} — HeyHenry`
      : 'New Change Order — HeyHenry',
  };
}

export default async function NewChangeOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const project = await getProject(id);
  if (!project) notFound();

  // Line-diff form is now the default. Apply-on-approval (kanban 8ce69bad)
  // and estimate-page guard (kanban 0f042025) are live, closing the loop.
  // Legacy even-distribute form still reachable via ?v2=0 as an escape hatch.
  const useDiffForm = sp.v2 !== '0';

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        href={`/projects/${id}?tab=change-orders`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Change Orders
      </Link>

      <h1 className="mb-2 text-2xl font-semibold tracking-tight">New Change Order</h1>
      <p className="mb-6 text-sm text-muted-foreground">Project: {project.name}</p>

      {useDiffForm ? (
        <ChangeOrderDiffForm
          projectId={id}
          budgetCategories={project.budget_categories}
          existingLines={await listCostLines(id)}
          defaultManagementFeeRate={project.management_fee_rate}
        />
      ) : (
        <ChangeOrderForm
          projectId={id}
          budgetCategories={project.budget_categories}
          defaultManagementFeeRate={project.management_fee_rate}
        />
      )}
    </div>
  );
}
