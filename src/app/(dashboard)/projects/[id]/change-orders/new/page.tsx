import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderForm } from '@/components/features/change-orders/change-order-form';
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

export default async function NewChangeOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        href={`/projects/${id}?tab=change-orders`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Change Orders
      </Link>

      <h1 className="mb-6 text-2xl font-semibold tracking-tight">New Change Order</h1>
      <p className="mb-6 text-sm text-muted-foreground">Project: {project.name}</p>

      <ChangeOrderForm projectId={id} budgetCategories={project.budget_categories} />
    </div>
  );
}
