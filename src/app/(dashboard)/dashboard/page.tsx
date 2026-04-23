import { KeyMetrics } from '@/components/features/dashboard/key-metrics';
import { NeedsAttention } from '@/components/features/dashboard/needs-attention';
import { PipelineSummary } from '@/components/features/dashboard/pipeline-summary';
import { RecentActivity } from '@/components/features/dashboard/recent-activity';
import { TodaysJobs } from '@/components/features/dashboard/todays-jobs';
import { getCurrentUser, requireTenant } from '@/lib/auth/helpers';
import {
  getAttentionItems,
  getHourInTimezone,
  getKeyMetrics,
  getPipelineMetrics,
  getRecentActivity,
  getRevenueYtd,
  getTodaysJobs,
} from '@/lib/db/queries/dashboard';
import { getBusinessProfile, getOperatorProfile } from '@/lib/db/queries/profile';

function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardPage() {
  const { tenant } = await requireTenant();
  const user = await getCurrentUser();
  const tz = tenant.timezone;
  const hour = getHourInTimezone(tz);
  const greeting = getGreeting(hour);

  const [
    todaysJobs,
    metrics,
    pipelineMetrics,
    attentionItems,
    recentActivity,
    revenueYtdCents,
    profile,
    operator,
  ] = await Promise.all([
    getTodaysJobs(tz),
    getKeyMetrics(tz),
    getPipelineMetrics(),
    getAttentionItems(tz),
    getRecentActivity(),
    getRevenueYtd(tz),
    getBusinessProfile(tenant.id),
    user ? getOperatorProfile(tenant.id, user.id) : Promise.resolve(null),
  ]);

  const firstName = operator?.firstName?.trim() || null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start gap-4">
        {profile?.logoSignedUrl ? (
          // biome-ignore lint/performance/noImgElement: signed URL
          <img
            src={profile.logoSignedUrl}
            alt={profile.name}
            className="h-14 w-auto max-w-[160px] shrink-0 rounded-md border bg-white object-contain p-1"
          />
        ) : null}
        <div>
          <h1 className="text-2xl font-semibold">{profile?.name ?? tenant.name}</h1>
          <p className="text-sm text-muted-foreground">
            {firstName ? `${greeting}, ${firstName}.` : `${greeting}.`} Here&apos;s your business at
            a glance.
          </p>
        </div>
      </div>

      <TodaysJobs jobs={todaysJobs} timezone={tz} />

      <PipelineSummary metrics={pipelineMetrics} />

      <KeyMetrics metrics={metrics} revenueYtdCents={revenueYtdCents} />

      <NeedsAttention items={attentionItems} />

      <RecentActivity entries={recentActivity} timezone={tz} />
    </div>
  );
}
