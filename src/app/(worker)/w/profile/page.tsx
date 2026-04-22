import Link from 'next/link';
import { WorkerProfileForm } from '@/components/features/worker/worker-profile-form';
import { Button } from '@/components/ui/button';
import { requireWorker } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';

export default async function WorkerProfilePage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Your details appear on time logs
          {profile.worker_type === 'subcontractor' ? ' and invoices you submit' : ''}.
        </p>
      </div>
      <WorkerProfileForm profile={profile} />
      <div className="border-t pt-4">
        <Button asChild variant="outline">
          <Link href="/logout">Log out</Link>
        </Button>
      </div>
    </div>
  );
}
