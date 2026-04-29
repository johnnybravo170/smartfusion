import { OverflowProbe } from '@/components/debug/overflow-probe';
import { ChecklistDashboardChip } from '@/components/features/checklist/dashboard-chip';
import { CommandCenter, PersonalTasksCard } from '@/components/features/dashboard/command-center';
import { EstimateCelebrationCard } from '@/components/features/dashboard/estimate-celebration-card';
import { KeyMetrics } from '@/components/features/dashboard/key-metrics';
import { MoneyAtRiskCard } from '@/components/features/dashboard/money-at-risk-card';
import { NeedsAttention } from '@/components/features/dashboard/needs-attention';
import { PipelineSummary } from '@/components/features/dashboard/pipeline-summary';
import { RecentActivity } from '@/components/features/dashboard/recent-activity';
import { RenovationPipelineSummary } from '@/components/features/dashboard/renovation-pipeline-summary';
import { TodaysJobs } from '@/components/features/dashboard/todays-jobs';
import { AwaitingApprovalList } from '@/components/features/projects/awaiting-approval-list';
import { getCurrentUser, requireTenant } from '@/lib/auth/helpers';
import { getRecentActivityFeed } from '@/lib/db/queries/activity-feed';
import { getProjectsAwaitingApproval } from '@/lib/db/queries/awaiting-approval';
import { listPendingChangeOrdersForDashboard } from '@/lib/db/queries/change-orders';
import {
  getAttentionItems,
  getHourInTimezone,
  getKeyMetrics,
  getPipelineMetrics,
  getRenovationPipelineMetrics,
  getRevenueYtd,
  getTodaysJobs,
} from '@/lib/db/queries/dashboard';
import { getPendingEstimateCelebration } from '@/lib/db/queries/estimate-celebrations';
import { listMoneyAtRisk } from '@/lib/db/queries/money-at-risk';
import { getBusinessProfile, getOperatorProfile } from '@/lib/db/queries/profile';
import {
  getDashboardTaskBuckets,
  getJobTaskHealth,
  listTasksAwaitingVerification,
} from '@/lib/db/queries/tasks';

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

  // GC/renovation work lives in multi-week projects; the "today's jobs"
  // appointment view is noise for that vertical. Other verticals (pressure
  // washing, etc.) keep it — they genuinely have a daily job schedule.
  const isRenovation = tenant.vertical === 'renovation' || tenant.vertical === 'tile';
  const showTodaysJobs = !isRenovation;

  const [
    todaysJobs,
    metrics,
    pipelineMetrics,
    renovationPipelineMetrics,
    awaitingApproval,
    celebration,
    attentionItems,
    recentActivity,
    revenueYtdCents,
    profile,
    operator,
    taskBuckets,
    jobTaskHealth,
    pendingChangeOrders,
  ] = await Promise.all([
    showTodaysJobs ? getTodaysJobs(tz) : Promise.resolve([]),
    getKeyMetrics(tz),
    isRenovation ? Promise.resolve(null) : getPipelineMetrics(),
    isRenovation ? getRenovationPipelineMetrics(tz) : Promise.resolve(null),
    getProjectsAwaitingApproval(),
    getPendingEstimateCelebration(),
    getAttentionItems(tz),
    getRecentActivityFeed(),
    getRevenueYtd(tz),
    getBusinessProfile(tenant.id),
    user ? getOperatorProfile(tenant.id, user.id) : Promise.resolve(null),
    user
      ? getDashboardTaskBuckets(user.id)
      : Promise.resolve({
          dueToday: [],
          overdue: [],
          blockedClient: [],
          blockedMaterial: [],
          blockedSub: [],
          blockedOther: [],
          personalTop: [],
        }),
    getJobTaskHealth(),
    listPendingChangeOrdersForDashboard(),
  ]);

  const moneyAtRisk = await listMoneyAtRisk(tenant.id);

  const tasksToVerify = await listTasksAwaitingVerification();

  const firstName = operator?.firstName?.trim() || null;
  const isJonathan = user?.email === 'jonathan@smartfusion.ca';

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
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl font-semibold sm:text-2xl">
            {profile?.name ?? tenant.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {firstName ? `${greeting}, ${firstName}.` : `${greeting}.`} Here&apos;s your business at
            a glance.
          </p>
        </div>
      </div>

      {celebration ? <EstimateCelebrationCard celebration={celebration} /> : null}

      <ChecklistDashboardChip />

      <CommandCenter
        buckets={taskBuckets}
        jobHealth={jobTaskHealth}
        changeOrdersPending={pendingChangeOrders}
        tasksToVerify={tasksToVerify}
      />

      <MoneyAtRiskCard rows={moneyAtRisk} />

      <PersonalTasksCard tasks={taskBuckets.personalTop} />

      {showTodaysJobs ? <TodaysJobs jobs={todaysJobs} timezone={tz} /> : null}

      <AwaitingApprovalList projects={awaitingApproval} variant="compact" />

      {renovationPipelineMetrics ? (
        <RenovationPipelineSummary metrics={renovationPipelineMetrics} />
      ) : pipelineMetrics ? (
        <PipelineSummary metrics={pipelineMetrics} />
      ) : null}

      <KeyMetrics metrics={metrics} revenueYtdCents={revenueYtdCents} />

      <NeedsAttention items={attentionItems} />

      <RecentActivity entries={recentActivity} timezone={tz} />

      {isJonathan ? <OverflowProbe /> : null}
    </div>
  );
}
