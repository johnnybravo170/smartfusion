import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { KeyMetrics as KeyMetricsData } from '@/lib/db/queries/dashboard';
import { formatCurrency } from '@/lib/pricing/calculator';

export function KeyMetrics({ metrics }: { metrics: KeyMetricsData }) {
  const cards = [
    {
      label: 'Revenue this month',
      value: formatCurrency(metrics.revenueThisMonthCents),
      detail: 'Paid invoices this month',
    },
    {
      label: 'Outstanding',
      value: formatCurrency(metrics.outstandingCents),
      detail: 'Sent invoices awaiting payment',
    },
    {
      label: 'Open jobs',
      value: metrics.openJobsCount,
      detail: 'Booked or in progress',
    },
    {
      label: 'Pending quotes',
      value: metrics.pendingQuotesCount,
      detail: 'Sent, awaiting response',
    },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.label}>
          <CardHeader>
            <CardDescription>{card.label}</CardDescription>
            <CardTitle className="text-3xl font-semibold tabular-nums">{card.value}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{card.detail}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
