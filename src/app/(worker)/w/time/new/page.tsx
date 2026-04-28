import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { WorkerTimeForm } from '@/components/features/worker/worker-time-form';
import { requireWorker } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { listWorkerProjectsWithBudgetCategories } from '@/lib/db/queries/worker-time';

export const dynamic = 'force-dynamic';

export default async function WorkerLogTimePage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const projects = await listWorkerProjectsWithBudgetCategories(tenant.id, profile.id);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/w/time" className="inline-flex items-center gap-1 text-sm text-muted-foreground">
        <ArrowLeft className="size-3.5" /> Time
      </Link>
      <h1 className="text-2xl font-semibold">Log time</h1>
      <WorkerTimeForm projects={projects} />
    </div>
  );
}
