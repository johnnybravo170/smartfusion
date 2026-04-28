import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderForm } from '@/components/features/change-orders/change-order-form';
import { getJob } from '@/lib/db/queries/jobs';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const job = await getJob(id);
  const customerName = job?.customer?.name ?? 'Job';
  return {
    title: job ? `New Change Order — ${customerName} — HeyHenry` : 'New Change Order — HeyHenry',
  };
}

export default async function NewJobChangeOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = await getJob(id);
  if (!job) notFound();

  const customerName = job.customer?.name ?? 'Unknown customer';

  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link
        href={`/jobs/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to job
      </Link>

      <h1 className="mb-6 text-2xl font-semibold tracking-tight">New Change Order</h1>
      <p className="mb-6 text-sm text-muted-foreground">Job for {customerName}</p>

      <ChangeOrderForm jobId={id} budgetCategories={[]} />
    </div>
  );
}
