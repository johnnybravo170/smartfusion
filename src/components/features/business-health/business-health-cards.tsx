/**
 * Five metric cards for /business-health. Server-renderable; pure display.
 */

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { BusinessHealthMetrics } from '@/lib/db/queries/business-health-metrics';
import { formatCurrency } from '@/lib/pricing/calculator';

const DRAW_TYPE_LABELS: Record<string, string> = {
  salary: 'Salary',
  dividend: 'Dividend',
  reimbursement: 'Reimburse',
  other: 'Other',
};

function ageInDays(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / (1000 * 60 * 60 * 24)));
}

export function BusinessHealthCards({ metrics }: { metrics: BusinessHealthMetrics }) {
  const arOldest = ageInDays(metrics.ar_outstanding.oldest_at);

  const cards: Array<{
    label: string;
    value: string;
    detail: string;
    href?: string;
    tone?: 'neutral' | 'positive' | 'negative';
  }> = [
    {
      label: `Revenue YTD ${metrics.year}`,
      value: formatCurrency(metrics.revenue_ytd_cents),
      detail: 'Paid invoices, fiscal year to date',
      href: '/invoices?status=paid',
    },
    {
      label: 'AR outstanding',
      value: formatCurrency(metrics.ar_outstanding.total_cents),
      detail:
        metrics.ar_outstanding.count === 0
          ? 'Nothing awaiting payment'
          : `${metrics.ar_outstanding.count} invoice${
              metrics.ar_outstanding.count === 1 ? '' : 's'
            }${arOldest !== null ? ` · oldest ${arOldest}d` : ''}`,
      href: '/invoices?status=sent',
      tone: arOldest !== null && arOldest >= 30 ? 'negative' : 'neutral',
    },
    {
      label: 'AP outstanding',
      value: formatCurrency(metrics.ap_outstanding.total_cents),
      detail:
        metrics.ap_outstanding.count === 0
          ? 'No unpaid bills'
          : `${metrics.ap_outstanding.count} bill${metrics.ap_outstanding.count === 1 ? '' : 's'} pending`,
    },
    {
      label: 'Owner pay YTD',
      value: formatCurrency(metrics.owner_pay_ytd.total_cents),
      detail: ownerPayDetail(metrics.owner_pay_ytd.by_type),
    },
    {
      label: 'Net cash flow YTD',
      value: formatCurrency(metrics.net_cash_flow_ytd_cents),
      detail: `Revenue − expenses − owner pay`,
      tone: metrics.net_cash_flow_ytd_cents >= 0 ? 'positive' : 'negative',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
      {cards.map((card) => (
        <MetricCard key={card.label} card={card} />
      ))}
    </div>
  );
}

function MetricCard({
  card,
}: {
  card: {
    label: string;
    value: string;
    detail: string;
    href?: string;
    tone?: 'neutral' | 'positive' | 'negative';
  };
}) {
  const inner = (
    <Card
      className={card.href ? 'h-full cursor-pointer transition-colors hover:bg-muted/50' : 'h-full'}
    >
      <CardHeader>
        <CardDescription>{card.label}</CardDescription>
        <CardTitle
          className={`text-2xl font-semibold tabular-nums ${
            card.tone === 'positive'
              ? 'text-emerald-600 dark:text-emerald-500'
              : card.tone === 'negative'
                ? 'text-rose-600 dark:text-rose-500'
                : ''
          }`}
        >
          {card.value}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{card.detail}</p>
      </CardContent>
    </Card>
  );

  if (card.href) {
    return (
      <Link href={card.href} className="contents">
        {inner}
      </Link>
    );
  }
  return inner;
}

function ownerPayDetail(byType: Partial<Record<string, number>>): string {
  const entries = Object.entries(byType).filter(([, cents]) => (cents ?? 0) > 0);
  if (entries.length === 0) return 'No draws recorded yet this year';
  return entries
    .map(([type, cents]) => `${DRAW_TYPE_LABELS[type] ?? type}: ${formatCurrency(cents ?? 0)}`)
    .join(' · ');
}
