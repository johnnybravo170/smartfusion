import { AlertCircle, Download } from 'lucide-react';
import Link from 'next/link';
import { requireBookkeeper } from '@/lib/auth/helpers';
import { getT4aReport } from '@/lib/db/queries/t4a-vendors';
import { formatCurrency } from '@/lib/pricing/calculator';

export const metadata = {
  title: 'T4A / vendors — Bookkeeper — HeyHenry',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseYear(v: string | string[] | undefined): number | null {
  if (typeof v !== 'string') return null;
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : null;
}

export default async function BookkeeperT4aPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { tenant } = await requireBookkeeper();
  const resolved = await searchParams;

  const currentYear = new Date().getFullYear();
  const year = parseYear(resolved.year) ?? currentYear;

  const report = await getT4aReport(tenant.id, year);
  const availableYears = [currentYear, currentYear - 1, currentYear - 2];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">T4A / vendors</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Vendors paid during {year}. CRA requires a T4A slip for any non-employee service
            provider paid $500+ in a calendar year.
          </p>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          {availableYears.map((y) => (
            <Link
              key={y}
              href={`/bk/t4a?year=${y}`}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                y === year
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-input hover:bg-muted'
              }`}
            >
              {y}
            </Link>
          ))}
        </nav>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Total paid" value={formatCurrency(report.total_cents)} />
        <StatCard label="Vendors paid" value={String(report.vendors.length)} />
        <StatCard
          label="Over $500 threshold"
          value={String(report.over_threshold_count)}
          tone={report.over_threshold_count > 0 ? 'warning' : 'neutral'}
        />
      </div>

      <section className="rounded-md border">
        <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
          <h2 className="text-sm font-medium">Vendor totals ({year})</h2>
          <a
            href={`/api/expenses/t4a-csv?year=${year}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Download className="size-3.5" />
            CSV
          </a>
        </div>
        {report.vendors.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No vendor payments recorded in {year}.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="px-4 py-2 text-left font-medium">Vendor</th>
                <th className="px-4 py-2 text-right font-medium">Transactions</th>
                <th className="px-4 py-2 text-right font-medium">Total paid</th>
                <th className="w-16 px-4 py-2 text-center font-medium">T4A</th>
              </tr>
            </thead>
            <tbody>
              {report.vendors.map((v) => (
                <tr
                  key={v.key}
                  className={
                    v.over_threshold
                      ? 'border-b bg-amber-50/40 last:border-0 dark:bg-amber-950/20'
                      : 'border-b last:border-0'
                  }
                >
                  <td className="px-4 py-2">{v.display}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {v.transaction_count}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {formatCurrency(v.amount_cents)}
                  </td>
                  <td className="px-4 py-2 text-center">
                    {v.over_threshold ? (
                      <span
                        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/60 dark:text-amber-200"
                        title="Over $500 threshold — T4A slip likely required"
                      >
                        <AlertCircle className="size-3" />
                        Yes
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Material suppliers (Home Depot, Rona) show up here alongside sub-trades. You decide who
        actually needs a slip. E-filing through Track1099 / Tax1099 is a separate step — export the
        CSV and feed it in, or paste into your existing filing workflow.
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'warning';
}) {
  const toneClass =
    tone === 'warning'
      ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
      : '';
  return (
    <div className={`rounded-md border p-4 ${toneClass}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
