import { Clock, FileText, FolderKanban, Send } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { PipelineMetrics } from '@/lib/db/queries/dashboard';
import { formatCurrency } from '@/lib/pricing/calculator';

/**
 * Dashboard pipeline snapshot — shows what the operator is actively
 * working on: drafts being written, quotes awaiting response, active
 * projects. Counts + values so they see "5 estimates in draft ($12K)".
 */
export function PipelineSummary({ metrics }: { metrics: PipelineMetrics }) {
  const cards: {
    label: string;
    count: number;
    valueCents: number | null;
    detail: string;
    icon: typeof FileText;
    href: string;
    accent?: 'warning';
  }[] = [
    {
      label: 'In draft',
      count: metrics.draftQuoteCount,
      valueCents: metrics.draftQuoteValueCents,
      detail: "Estimates you're working on",
      icon: FileText,
      href: '/quotes?status=draft',
    },
    {
      label: 'Sent',
      count: metrics.sentQuoteCount,
      valueCents: metrics.sentQuoteValueCents,
      detail: 'Quotes awaiting response',
      icon: Send,
      href: '/quotes?status=sent',
    },
    {
      label: 'Expired',
      count: metrics.expiredQuoteCount,
      valueCents: metrics.expiredQuoteValueCents,
      detail: 'Stalled — follow up or extend',
      icon: Clock,
      href: '/quotes?status=expired',
      accent: metrics.expiredQuoteCount > 0 ? 'warning' : undefined,
    },
    {
      label: 'Active projects',
      count: metrics.activeProjectCount,
      valueCents: metrics.activeProjectValueCents,
      detail: 'Planning or in progress',
      icon: FolderKanban,
      href: '/projects?view=active',
    },
  ];

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">Pipeline</h2>
        <Link href="/quotes" className="text-xs text-muted-foreground hover:underline">
          View all →
        </Link>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          const warning = card.accent === 'warning';
          return (
            <Link key={card.label} href={card.href}>
              <Card
                className={
                  warning
                    ? 'cursor-pointer border-amber-300 bg-amber-50 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/40 dark:hover:bg-amber-950/60'
                    : 'cursor-pointer transition-colors hover:bg-muted/50'
                }
              >
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardDescription>{card.label}</CardDescription>
                    <Icon
                      className={
                        warning
                          ? 'size-4 text-amber-700 dark:text-amber-300'
                          : 'size-4 text-muted-foreground'
                      }
                    />
                  </div>
                  <CardTitle className="text-3xl font-semibold tabular-nums">
                    {card.count}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {card.valueCents !== null ? (
                    <p className="text-sm font-medium tabular-nums">
                      {formatCurrency(card.valueCents)}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted-foreground">{card.detail}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
