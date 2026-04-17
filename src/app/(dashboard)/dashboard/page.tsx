import { KeyMetrics } from '@/components/features/dashboard/key-metrics';
import { NeedsAttention } from '@/components/features/dashboard/needs-attention';
import { RecentActivity } from '@/components/features/dashboard/recent-activity';
import { TodaysJobs } from '@/components/features/dashboard/todays-jobs';
import { requireTenant } from '@/lib/auth/helpers';
import {
  getAttentionItems,
  getHourInTimezone,
  getKeyMetrics,
  getRecentActivity,
  getTodaysJobs,
} from '@/lib/db/queries/dashboard';

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardPage() {
  const { tenant } = await requireTenant();
  const tz = tenant.timezone;
  const hour = getHourInTimezone(tz);
  const greeting = getGreeting(hour);

  const [todaysJobs, metrics, attentionItems, recentActivity] = await Promise.all([
    getTodaysJobs(tz),
    getKeyMetrics(tz),
    getAttentionItems(tz),
    getRecentActivity(),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          {greeting}, {tenant.name}. Here&apos;s your business at a glance.
        </p>
      </div>

      <TodaysJobs jobs={todaysJobs} timezone={tz} />

      <KeyMetrics metrics={metrics} />

      <NeedsAttention items={attentionItems} />

      <RecentActivity entries={recentActivity} timezone={tz} />
    </div>
  );
}
