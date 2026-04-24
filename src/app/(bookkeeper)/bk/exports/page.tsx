import { Download, FileText } from 'lucide-react';
import Link from 'next/link';
import { BooksCloseCard } from '@/components/features/expenses/books-close-card';
import { requireBookkeeper } from '@/lib/auth/helpers';
import { gstPeriodPresets } from '@/lib/db/queries/gst-remittance';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata = {
  title: 'Exports — Bookkeeper — HeyHenry',
};

export default async function BookkeeperExportsPage() {
  const { tenant } = await requireBookkeeper();

  const admin = createAdminClient();
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('books_closed_through')
    .eq('id', tenant.id)
    .maybeSingle();
  const closedThrough = (tenantRow?.books_closed_through as string | null) ?? null;

  const currentYear = new Date().getFullYear();

  // Current-quarter default for the live exports that exist today.
  const thisQuarter = gstPeriodPresets().find((p) => p.key === 'this_quarter');
  const period = thisQuarter?.period ?? { from: '2026-01-01', to: '2026-12-31' };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Year-end exports</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Download what you need for filing + lock periods after submission.
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Period close</h2>
        <BooksCloseCard currentClosedThrough={closedThrough} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Downloads</h2>
        <Link
          href={`/api/expenses/gst-remittance-csv?from=${period.from}&to=${period.to}`}
          className="flex items-center justify-between rounded-md border bg-card p-4 hover:bg-muted/30"
        >
          <div className="flex items-center gap-3">
            <FileText className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">GST/HST remittance ({thisQuarter?.label})</p>
              <p className="text-xs text-muted-foreground">
                Summary + ITC breakdown by category · CSV
              </p>
            </div>
          </div>
          <Download className="size-4 text-muted-foreground" />
        </Link>

        <Link
          href={`/api/expenses/t4a-csv?year=${currentYear}`}
          className="flex items-center justify-between rounded-md border bg-card p-4 hover:bg-muted/30"
        >
          <div className="flex items-center gap-3">
            <FileText className="size-5 text-muted-foreground" />
            <div>
              <p className="text-sm font-medium">T4A vendor report ({currentYear})</p>
              <p className="text-xs text-muted-foreground">
                Every vendor paid + over-$500 flag · CSV
              </p>
            </div>
          </div>
          <Download className="size-4 text-muted-foreground" />
        </Link>

        <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/10 p-4 text-muted-foreground">
          <div className="flex items-center gap-3">
            <FileText className="size-5" />
            <div>
              <p className="text-sm font-medium">Full year-end package</p>
              <p className="text-xs">
                Zip bundle: all expenses + bills + invoices + receipts. Coming soon.
              </p>
            </div>
          </div>
        </div>
      </section>

      <p className="text-xs text-muted-foreground">
        Need a different date range?{' '}
        <Link href="/bk/gst" className="font-medium hover:underline">
          Change period on the GST page
        </Link>{' '}
        then re-download. T4A report filter lives on{' '}
        <Link href="/bk/t4a" className="font-medium hover:underline">
          the T4A page
        </Link>
        .
      </p>
    </div>
  );
}
