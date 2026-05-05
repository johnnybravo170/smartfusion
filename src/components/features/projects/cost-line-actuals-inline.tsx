'use client';

/**
 * Inline expansion under a cost line on the unified Budget tab. Shows
 * what's been spent specifically on this line — hours billed, bills,
 * expenses, PO line items — pulled from the cost_line_id FKs added
 * in migration 0166.
 *
 * Pre-fetched at the page level via getCostLineActualsByProject and
 * passed in as a prop. No per-expand round-trips, no loading states —
 * the data is already on the page when the operator clicks.
 */

import { ArrowUpRight, Banknote, Clock, FileText, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import type { CostLineActualsSummary } from '@/lib/db/queries/cost-line-actuals';
import { formatCurrency } from '@/lib/pricing/calculator';

const KIND_ICONS = {
  labour: Clock,
  expense: Banknote,
  bill: FileText,
  po: ShoppingBag,
} as const;

const KIND_LABELS = {
  labour: 'Labour',
  expense: 'Expense',
  bill: 'Bill',
  po: 'PO',
} as const;

const EMPTY: CostLineActualsSummary = {
  total_cents: 0,
  labour_hours: 0,
  labour_cents: 0,
  expenses_cents: 0,
  bills_cents: 0,
  po_cents: 0,
  rows: [],
};

export function CostLineActualsInline({
  projectId,
  costLineId,
  costLineLabel,
  actuals,
}: {
  projectId: string;
  costLineId: string;
  costLineLabel: string;
  /** Pre-fetched line actuals; undefined = no actuals on this line. */
  actuals?: CostLineActualsSummary;
}) {
  const data = actuals ?? EMPTY;

  if (data.rows.length === 0) {
    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        Nothing has been spent against{' '}
        <span className="font-medium text-foreground">{costLineLabel}</span> yet. Bills, expenses,
        and time entries can be assigned to this line on their own forms.
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-xs">
      {/* Summary strip — labour hours up front since that's the */}
      {/* operator's most common drill-in: "how many hours have we put */}
      {/* on this line?" */}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        {data.labour_hours > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">{data.labour_hours.toFixed(1)} hrs</span>
            <span className="text-muted-foreground"> labour</span>
          </span>
        ) : null}
        {data.labour_cents > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">{formatCurrency(data.labour_cents)}</span>
            <span className="text-muted-foreground"> in labour cost</span>
          </span>
        ) : null}
        {data.bills_cents > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">{formatCurrency(data.bills_cents)}</span>
            <span className="text-muted-foreground"> in bills</span>
          </span>
        ) : null}
        {data.expenses_cents > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">
              {formatCurrency(data.expenses_cents)}
            </span>
            <span className="text-muted-foreground"> in expenses</span>
          </span>
        ) : null}
        {data.po_cents > 0 ? (
          <span>
            <span className="font-semibold tabular-nums">{formatCurrency(data.po_cents)}</span>
            <span className="text-muted-foreground"> committed (POs)</span>
          </span>
        ) : null}
        <span className="ml-auto font-semibold tabular-nums">
          {formatCurrency(data.total_cents)} total
        </span>
      </div>

      {/* Per-row breakdown — most-recent first. */}
      <ul className="divide-y divide-muted">
        {data.rows.slice(0, 10).map((r) => {
          const Icon = KIND_ICONS[r.kind];
          const date = new Date(r.occurred_at).toLocaleDateString('en-CA', {
            month: 'short',
            day: 'numeric',
          });
          return (
            <li key={`${r.kind}-${r.id}`} className="flex items-center gap-2 py-1.5">
              <Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                {KIND_LABELS[r.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {r.label}
                {r.sublabel ? <span className="text-muted-foreground"> — {r.sublabel}</span> : null}
              </span>
              <span className="shrink-0 text-muted-foreground">{date}</span>
              <span className="shrink-0 tabular-nums font-medium">
                {formatCurrency(r.amount_cents)}
              </span>
            </li>
          );
        })}
      </ul>

      {data.rows.length > 10 ? (
        <p className="text-[10px] text-muted-foreground">
          Showing 10 most recent of {data.rows.length} entries.
        </p>
      ) : null}

      <Link
        href={`/projects/${projectId}?tab=costs&focus_line=${costLineId}`}
        className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        Open in Spend tab
        <ArrowUpRight className="size-3" />
      </Link>
    </div>
  );
}
