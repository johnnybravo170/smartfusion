import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderList } from '@/components/features/change-orders/change-order-list';
import { listChangeOrders } from '@/lib/db/queries/change-orders';
import { getProject } from '@/lib/db/queries/projects';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  return {
    title: project ? `Change Orders — ${project.name} — HeyHenry` : 'Change Orders — HeyHenry',
  };
}

export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const changeOrders = await listChangeOrders(id);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        href={`/projects/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {project.name}
      </Link>

      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Change Orders</h1>
        <Link
          href={`/projects/${id}/change-orders/new`}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New Change Order
        </Link>
      </header>

      <ChangeOrderList changeOrders={changeOrders} projectId={id} />
    </div>
  );
}
