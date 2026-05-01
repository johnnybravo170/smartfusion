import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { BusinessHealthCards } from '@/components/features/business-health/business-health-cards';
import { OwnerDrawsPanel } from '@/components/features/business-health/owner-draws-panel';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getBusinessHealthMetrics } from '@/lib/db/queries/business-health-metrics';
import { listOwnerDrawsAction } from '@/server/actions/owner-draws';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Business Health',
};

export default async function BusinessHealthPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  const year = new Date().getFullYear();
  const [metrics, drawsResult] = await Promise.all([
    getBusinessHealthMetrics(year),
    listOwnerDrawsAction({ year }),
  ]);

  const draws = drawsResult.ok ? drawsResult.rows : [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold sm:text-2xl">Business Health</h1>
        <p className="text-sm text-muted-foreground">
          Where your business stands this year — revenue in, money out, owner pay.
        </p>
      </header>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-md bg-muted" />}>
        <BusinessHealthCards metrics={metrics} />
      </Suspense>

      <OwnerDrawsPanel initialRows={draws} year={year} />
    </div>
  );
}
