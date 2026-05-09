import { Suspense } from 'react';
import { FirstRunHero } from '@/components/features/dashboard/first-run-hero';
import { getCurrentUser, requireTenant } from '@/lib/auth/helpers';
import { getHourInTimezone } from '@/lib/db/queries/dashboard';
import { isFirstRunTenant } from '@/lib/db/queries/first-run';
import { getBusinessProfile, getOperatorProfile } from '@/lib/db/queries/profile';
import { AttentionSection } from './_sections/attention-section';
import { JobsSection } from './_sections/jobs-section';
import { MetricsSection } from './_sections/metrics-section';
import { PipelineSection } from './_sections/pipeline-section';
import {
  AttentionSkeleton,
  JobsSkeleton,
  MetricsSkeleton,
  PipelineSkeleton,
} from './_sections/skeletons';

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

  const [profile, operator, firstRun] = await Promise.all([
    getBusinessProfile(tenant.id),
    user ? getOperatorProfile(tenant.id, user.id) : Promise.resolve(null),
    isFirstRunTenant(tenant.id),
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
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl font-semibold sm:text-2xl">
            {profile?.name ?? tenant.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            {firstName
              ? `${greeting}, ${firstName}. Here's your business at a glance.`
              : `${greeting}. Here's your business at a glance.`}
          </p>
        </div>
      </div>

      {firstRun ? <FirstRunHero firstName={firstName} vertical={tenant.vertical} /> : null}

      <Suspense fallback={<AttentionSkeleton />}>
        <AttentionSection />
      </Suspense>

      <Suspense fallback={<JobsSkeleton />}>
        <JobsSection />
      </Suspense>

      <Suspense fallback={<PipelineSkeleton />}>
        <PipelineSection />
      </Suspense>

      <Suspense fallback={<MetricsSkeleton />}>
        <MetricsSection />
      </Suspense>
    </div>
  );
}
