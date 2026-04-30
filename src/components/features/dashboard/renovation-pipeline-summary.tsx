import { CheckCircle2, FileText, FolderKanban, Send } from 'lucide-react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { RenovationPipelineMetrics } from '@/lib/db/queries/dashboard';
import { formatCurrency } from '@/lib/pricing/calculator';

/**
 * Dashboard pipeline cards for the renovation vertical. All four cards
 * are project-scoped and click-through to the matching Projects tab —
 * no polygon quoting tool detour.
 *
 * Mirrors the shape of PipelineSummary so the dashboard layout stays
 * identical. The non-renovation verticals still use PipelineSummary.
 */
export function RenovationPipelineSummary({ metrics }: { metrics: RenovationPipelineMetrics }) {
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
      label: 'Planning',
      count: metrics.planningCount,
      valueCents: metrics.planningValueCents,
      detail: "Estimates you're building",
      icon: FileText,
      href: '/projects',
    },
    {
      label: 'Awaiting approval',
      count: metrics.awaitingApprovalCount,
      valueCents: metrics.awaitingApprovalValueCents,
      detail: 'Estimates sent to customer',
      icon: Send,
      href: '/projects?view=awaiting_approval',
      accent: metrics.awaitingApprovalCount > 0 ? 'warning' : undefined,
    },
    {
      label: 'Active',
      count: metrics.activeCount,
      valueCents: metrics.activeValueCents,
      detail: 'Approved and in progress',
      icon: FolderKanban,
      href: '/projects?view=active',
    },
    {
      label: 'Complete this year',
      count: metrics.completeThisYearCount,
      valueCents: null,
      detail: 'Finished projects YTD',
      icon: CheckCircle2,
      href: '/projects?view=complete',
    },
  ];

  return (
    <section>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">Pipeline</h2>
        <Link href="/projects" className="text-xs text-muted-foreground hover:underline">
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
