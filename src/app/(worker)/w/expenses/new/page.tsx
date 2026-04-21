import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { WorkerExpenseForm } from '@/components/features/worker/worker-expense-form';
import { requireWorker } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { listWorkerProjectsWithBuckets } from '@/lib/db/queries/worker-time';

export const dynamic = 'force-dynamic';

export default async function WorkerLogExpensePage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const projects = await listWorkerProjectsWithBuckets(tenant.id, profile.id);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/w/expenses"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-3.5" /> Expenses
      </Link>
      <h1 className="text-2xl font-semibold">Log expense</h1>
      <WorkerExpenseForm projects={projects} />
    </div>
  );
}
