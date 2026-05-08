import { TodaysJobs } from '@/components/features/dashboard/todays-jobs';
import { AwaitingApprovalList } from '@/components/features/projects/awaiting-approval-list';
import { requireTenant } from '@/lib/auth/helpers';
import { getProjectsAwaitingApproval } from '@/lib/db/queries/awaiting-approval';
import { getTodaysJobs } from '@/lib/db/queries/dashboard';

export async function JobsSection() {
  const { tenant } = await requireTenant();
  const tz = tenant.timezone;
  const isRenovation = tenant.vertical === 'renovation' || tenant.vertical === 'tile';
  const showTodaysJobs = !isRenovation;

  const [todaysJobs, awaitingApproval] = await Promise.all([
    showTodaysJobs ? getTodaysJobs(tz) : Promise.resolve([]),
    getProjectsAwaitingApproval(),
  ]);

  return (
    <>
      {showTodaysJobs ? <TodaysJobs jobs={todaysJobs} timezone={tz} /> : null}
      <AwaitingApprovalList projects={awaitingApproval} variant="compact" />
    </>
  );
}
