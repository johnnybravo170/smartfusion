import { GstRemittancePanel } from '@/components/features/expenses/gst-remittance-panel';
import { requireBookkeeper } from '@/lib/auth/helpers';
import {
  getGstRemittanceReport,
  gstPeriodPresets,
  type RemittancePeriod,
} from '@/lib/db/queries/gst-remittance';
import { canadianTax } from '@/lib/providers/tax/canadian';

export const metadata = {
  title: 'GST/HST — Bookkeeper — HeyHenry',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseDate(v: string | string[] | undefined): string | null {
  if (typeof v !== 'string') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export default async function BookkeeperGstPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const { tenant } = await requireBookkeeper();
  const resolved = await searchParams;
  const presets = gstPeriodPresets();
  const defaultPeriod = presets.find((p) => p.key === 'this_quarter')?.period ?? presets[0].period;
  const from = parseDate(resolved.from) ?? defaultPeriod.from;
  const to = parseDate(resolved.to) ?? defaultPeriod.to;
  const period: RemittancePeriod = { from, to };

  const [report, taxCtx] = await Promise.all([
    getGstRemittanceReport(tenant.id, period),
    canadianTax.getContext(tenant.id).catch(() => null),
  ]);
  const taxLabel = taxCtx?.summaryLabel ?? 'GST/HST';

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">GST/HST remittance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Collected minus ITCs = net owed. Export the CSV at filing time.
        </p>
      </header>

      <GstRemittancePanel
        report={report}
        presets={presets}
        activeFrom={from}
        activeTo={to}
        taxLabel={taxLabel}
        basePath="/bk/gst"
        backHref="/bk/expenses"
      />
    </div>
  );
}
