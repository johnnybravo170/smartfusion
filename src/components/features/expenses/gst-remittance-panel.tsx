'use client';

/**
 * GST/HST remittance UI.
 *
 * Server-rendered stats + a client-side period picker (preset pills +
 * custom range) that reloads via URL params. CSV export bundles the
 * whole report so a bookkeeper can drop it into their workflow.
 */

import { Download } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { GstRemittanceReport, RemittancePeriod } from '@/lib/db/queries/gst-remittance';
import { formatCurrency } from '@/lib/pricing/calculator';

type Preset = {
  key: string;
  label: string;
  period: RemittancePeriod;
};

type Props = {
  report: GstRemittanceReport;
  presets: Preset[];
  activeFrom: string;
  activeTo: string;
  taxLabel: string;
  /** Route to push to when the user changes the period. Defaults to
   * the operator GST page; the bookkeeper portal passes /bk/gst. */
  basePath?: string;
  /** Link back to the expense list. Operator = /expenses, bookkeeper
   * = /bk/expenses. Pass null to hide the link entirely. */
  backHref?: string | null;
};

export function GstRemittancePanel({
  report,
  presets,
  activeFrom,
  activeTo,
  taxLabel,
  basePath = '/expenses/gst',
  backHref = '/expenses',
}: Props) {
  const router = useRouter();
  const [customFrom, setCustomFrom] = useState(activeFrom);
  const [customTo, setCustomTo] = useState(activeTo);

  function applyPeriod(from: string, to: string) {
    const params = new URLSearchParams();
    params.set('from', from);
    params.set('to', to);
    router.push(`${basePath}?${params.toString()}`);
  }

  const activePreset = presets.find(
    (p) => p.period.from === activeFrom && p.period.to === activeTo,
  );

  const net = report.net_owed_cents;
  const owesGovernment = net > 0;

  return (
    <div className="flex flex-col gap-6">
      {/* Preset pills + custom range */}
      <div className="flex flex-col gap-4 rounded-md border bg-muted/10 p-4">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => {
            const isActive = activePreset?.key === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPeriod(p.period.from, p.period.to)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  isActive
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-input hover:bg-muted'
                }`}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="gst-from" className="text-xs">
              From
            </Label>
            <Input
              id="gst-from"
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="gst-to" className="text-xs">
              To
            </Label>
            <Input
              id="gst-to"
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyPeriod(customFrom, customTo)}
            disabled={!customFrom || !customTo || customFrom > customTo}
          >
            Apply
          </Button>
        </div>
      </div>

      {/* Headline numbers */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card
          label="Collected on invoices"
          amount={report.collected.tax_cents}
          note={`${report.collected.invoice_count} paid invoice${report.collected.invoice_count === 1 ? '' : 's'}`}
          tone="neutral"
        />
        <Card
          label="Input Tax Credits (paid)"
          amount={report.paid_on_expenses.tax_cents + report.paid_on_bills.tax_cents}
          note={`${report.paid_on_expenses.count} expense${report.paid_on_expenses.count === 1 ? '' : 's'} · ${report.paid_on_bills.count} bill${report.paid_on_bills.count === 1 ? '' : 's'}`}
          tone="neutral"
        />
        <Card
          label={owesGovernment ? 'Net owed to CRA' : 'Net refund due'}
          amount={Math.abs(net)}
          note={owesGovernment ? 'File + remit this' : 'Claim on return'}
          tone={owesGovernment ? 'warning' : 'good'}
        />
      </div>

      {/* Category breakdown on expenses side */}
      <section className="rounded-md border">
        <div className="flex items-center justify-between border-b bg-muted/30 px-4 py-2">
          <h2 className="text-sm font-medium">
            ITC breakdown by category ({taxLabel} paid on expenses)
          </h2>
          <a
            href={`/api/expenses/gst-remittance-csv?from=${activeFrom}&to=${activeTo}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Download className="size-3.5" />
            CSV
          </a>
        </div>
        {report.paid_on_expenses.by_category.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No expense tax recorded in this period.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="px-4 py-2 text-left font-medium">Category</th>
                <th className="px-4 py-2 text-right font-medium">Pre-tax subtotal</th>
                <th className="px-4 py-2 text-right font-medium">ITC (GST/HST)</th>
              </tr>
            </thead>
            <tbody>
              {report.paid_on_expenses.by_category.map((line) => (
                <tr key={line.category_id ?? 'none'} className="border-b last:border-0">
                  <td className="px-4 py-2">{line.category_label}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                    {formatCurrency(line.amount_cents)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {formatCurrency(line.tax_cents)}
                  </td>
                </tr>
              ))}
              <tr className="bg-muted/20">
                <td className="px-4 py-2 font-medium">Bills (project-linked)</td>
                <td className="px-4 py-2 text-right tabular-nums text-muted-foreground">
                  {formatCurrency(report.paid_on_bills.amount_cents)}
                </td>
                <td className="px-4 py-2 text-right tabular-nums font-medium">
                  {formatCurrency(report.paid_on_bills.tax_cents)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        {backHref ? (
          <>
            <Link href={backHref} className="hover:underline">
              ← Back to expenses
            </Link>
            {' · '}
          </>
        ) : null}
        Tax figures come from what&apos;s stored on each record, not re-computed from rates. If an
        expense is missing its tax amount, it won&apos;t show up as an ITC here.
      </p>
    </div>
  );
}

function Card({
  label,
  amount,
  note,
  tone,
}: {
  label: string;
  amount: number;
  note: string;
  tone: 'neutral' | 'warning' | 'good';
}) {
  const toneClass =
    tone === 'warning'
      ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/40'
      : tone === 'good'
        ? 'border-emerald-300 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950/40'
        : 'bg-card';
  return (
    <div className={`rounded-md border p-4 ${toneClass}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCurrency(amount)}</p>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}
