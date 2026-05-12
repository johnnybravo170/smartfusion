import { AlertTriangle, Receipt } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireBookkeeper } from '@/lib/auth/helpers';
import { getGstRemittanceReport, gstPeriodPresets } from '@/lib/db/queries/gst-remittance';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata = {
  title: 'Bookkeeper — HeyHenry',
};

export default async function BookkeeperHomePage() {
  const { tenant } = await requireBookkeeper();
  const admin = createAdminClient();

  // Two pieces of work actually surfaced on the home page:
  //   1. Current-quarter GST picture (headline).
  //   2. Uncategorized expense count (real friction for filing).
  const thisQuarter = gstPeriodPresets().find((p) => p.key === 'this_quarter');
  const period = thisQuarter?.period ?? { from: '2026-01-01', to: '2026-12-31' };

  const [report, uncategorized] = await Promise.all([
    getGstRemittanceReport(tenant.id, period),
    admin
      .from('project_costs')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('source_type', 'receipt')
      .eq('status', 'active')
      .is('category_id', null),
  ]);

  const uncategorizedCount = uncategorized.count ?? 0;
  const net = report.net_owed_cents;
  const owes = net > 0;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Bookkeeper overview</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Financial surfaces for {tenant.name}. Pick a section from the left.
        </p>
      </header>

      {/* Current-quarter GST picture */}
      <section className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader>
            <CardDescription>{thisQuarter?.label ?? 'Current quarter'}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatCurrency(report.collected.tax_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            Collected on {report.collected.invoice_count} paid invoice
            {report.collected.invoice_count === 1 ? '' : 's'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription>Input Tax Credits</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {formatCurrency(report.paid_overhead.tax_cents + report.paid_project_work.tax_cents)}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            {report.paid_overhead.count} overhead · {report.paid_project_work.expense_count} project
            expenses · {report.paid_project_work.bill_count} bills
          </CardContent>
        </Card>

        <Card
          className={
            owes
              ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
              : 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40'
          }
        >
          <CardHeader>
            <CardDescription>{owes ? 'Net owed to CRA' : 'Net refund'}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatCurrency(Math.abs(net))}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link href="/bk/gst" className="text-xs font-medium hover:underline">
              Open remittance report →
            </Link>
          </CardContent>
        </Card>
      </section>

      {/* Things to action */}
      <section>
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Needs attention</h2>
        <div className="flex flex-col gap-3">
          {uncategorizedCount > 0 ? (
            <Link
              href="/bk/expenses?uncategorized=1"
              className="flex items-center justify-between rounded-md border bg-amber-50 p-4 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-950/60"
            >
              <div className="flex items-center gap-3">
                <AlertTriangle className="size-5 text-amber-700 dark:text-amber-300" />
                <div>
                  <p className="text-sm font-medium">
                    {uncategorizedCount} uncategorized expense
                    {uncategorizedCount === 1 ? '' : 's'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Assign categories so they show up in the right ITC line.
                  </p>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">Review →</span>
            </Link>
          ) : (
            <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
              <Receipt className="size-5" />
              Everything is categorized. Quiet around here.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
