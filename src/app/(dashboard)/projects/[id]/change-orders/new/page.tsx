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

  // Phase 1 line-diff form: opt-in via ?v2=1. Existing flow stays default
  // until the diff editor is fully verified end-to-end (apply-on-approval,
  // estimate-page guard, audit log). See decisions log + kanban 707d5395.
  const useDiffForm = sp.v2 === '1';

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
      <p className="mb-6 text-sm text-muted-foreground">
        Project: {project.name}
        {useDiffForm ? (
          <>
            {' '}
            ·{' '}
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
              line-diff preview
            </span>
          </>
        ) : null}
      </p>

      {useDiffForm ? (
        <ChangeOrderDiffForm
          projectId={id}
          budgetCategories={project.budget_categories}
          existingLines={await listCostLines(id)}
        />
      ) : (
        <ChangeOrderForm projectId={id} budgetCategories={project.budget_categories} />
      )}
    </div>
  );
}
