import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { KeyMetrics as KeyMetricsData } from '@/lib/db/queries/dashboard';
import { formatCurrency } from '@/lib/pricing/calculator';

export function KeyMetrics({
  metrics,
  revenueYtdCents,
}: {
  metrics: KeyMetricsData;
  revenueYtdCents: number;
}) {
  const cards = [
    {
      label: 'Revenue this month',
      value: formatCurrency(metrics.revenueThisMonthCents),
      detail: `YTD: ${formatCurrency(revenueYtdCents)}`,
      href: '/invoices?status=paid',
    },
    {
      label: 'Outstanding',
      value: formatCurrency(metrics.outstandingCents),
      detail: 'Sent invoices awaiting payment',
      href: '/invoices?status=sent',
    },
    {
      label: 'Open jobs',
      value: metrics.openJobsCount,
      detail: 'Booked or in progress',
      href: '/jobs',
    },
    {
      label: 'Pending quotes',
      value: metrics.pendingQuotesCount,
      detail: 'Sent, awaiting response',
      href: '/quotes?status=sent',
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Link key={card.label} href={card.href}>
          <Card className="cursor-pointer transition-colors hover:bg-muted/50">
            <CardHeader>
              <CardDescription>{card.label}</CardDescription>
              <CardTitle className="text-3xl font-semibold tabular-nums">{card.value}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{card.detail}</p>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}
