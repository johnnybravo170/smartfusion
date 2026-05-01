import { Info, Upload } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { BusinessHealthCards } from '@/components/features/business-health/business-health-cards';
import { OwnerDrawsPanel } from '@/components/features/business-health/owner-draws-panel';
import { Button } from '@/components/ui/button';
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
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold sm:text-2xl">Business Health</h1>
          <p className="text-sm text-muted-foreground">
            Where your business stands this year — revenue in, money out, owner pay.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/business-health/bank-import">
            <Upload className="size-4" />
            <span className="ml-1">Import bank statement</span>
          </Link>
        </Button>
      </header>

      <Suspense fallback={<div className="h-32 animate-pulse rounded-md bg-muted" />}>
        <BusinessHealthCards metrics={metrics} />
      </Suspense>

      <OwnerDrawsPanel initialRows={draws} year={year} />

      <aside className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <Info className="size-3.5" />
          How this fits with your bookkeeping
        </div>
        <p>
          This page is your <strong>operational view</strong> — fast snapshots so you can see where
          you stand today. Your books still live in QuickBooks (or wherever your bookkeeper works);
          HeyHenry pushes the important transactions over so they see clean data without re-entering
          anything. We don't try to replace bank reconciliation in QBO.
        </p>
        <p className="mt-2">
          Tip: instead of clicking "mark paid" on every invoice, drop your monthly bank statement
          into{' '}
          <Link href="/business-health/bank-import" className="underline hover:text-foreground">
            Import bank statement
          </Link>{' '}
          — we'll find your unpaid invoices and expenses inside it and mark them paid in one go.
        </p>
      </aside>
    </div>
  );
}
