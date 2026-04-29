'use client';

import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { AppliedChangeOrderContribution } from '@/lib/db/queries/change-orders';
import { formatCurrency } from '@/lib/pricing/calculator';

type VarianceData = {
  estimated_cents: number;
  lines_subtotal_cents: number;
  mgmt_fee_cents: number;
  mgmt_fee_rate: number;
  mgmt_fee_breakdown: {
    baseline_lines_cents: number;
    baseline_fee_cents: number;
    co_overrides: {
      co_id: string;
      cost_impact_cents: number;
      override_rate: number;
      fee_cents: number;
    }[];
    effective_rate: number;
  };
  envelope_total_cents: number;
  applied_co_impact_cents: number;
  pending_co_impact_cents: number;
  pending_co_count: number;
  committed_cents: number;
  committed_vendor_quotes_cents: number;
  committed_pos_cents: number;
  actual_bills_cents: number;
  actual_expenses_cents: number;
  actual_labour_cents: number;
  actual_total_cents: number;
  margin_at_risk_cents: number;
  by_category: {
    category: string;
    estimated_cents: number;
    committed_cents: number;
    actual_cents: number;
    margin_at_risk_cents: number;
  }[];
};

function StatBox({
  label,
  value,
  sub,
  highlight,
  danger,
  success,
}: {
  label: string;
  value: string;
  sub?: string;
  highlight?: boolean;
  danger?: boolean;
  success?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${success ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800' : highlight ? 'bg-primary/5 border-primary/30' : ''} ${danger ? 'bg-destructive/5 border-destructive/30' : ''}`}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`mt-1 text-xl font-semibold tabular-nums ${danger ? 'text-destructive' : success ? 'text-emerald-700 dark:text-emerald-300' : highlight ? 'text-primary' : ''}`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

type AnyCoSummary = {
  id: string;
  title: string;
  short_id: string;
  cost_impact_cents: number;
  status: 'draft' | 'pending_approval' | 'approved' | 'declined' | 'voided';
  flow_version: 1 | 2;
  applied_at: string | null;
  approved_at: string | null;
  management_fee_override_rate: number | null;
  management_fee_override_reason: string | null;
  revenue_kind: 'applied' | 'approved_legacy' | 'pending' | 'other';
};

export function VarianceTab({
  variance,
  lifecycleStage,
  projectId,
  appliedChangeOrders = [],
  allChangeOrders = [],
  coContributionsByCategoryId = {},
  categoryIdByName = {},
}: {
  variance: VarianceData;
  lifecycleStage?: string;
  projectId?: string;
  /** Audit lens — applied COs on this project. Used to (a) layer the
   *  total CO contribution into the Estimated Revenue stat, and (b)
   *  attach chips to category rows that were touched. */
  appliedChangeOrders?: {
    id: string;
    title: string;
    short_id: string;
    applied_at: string;
    cost_impact_cents: number;
  }[];
  /** Every CO on the project so the Revenue card can show v1 / pending /
   *  approved-not-applied COs alongside applied ones. */
  allChangeOrders?: AnyCoSummary[];
  coContributionsByCategoryId?: Record<string, AppliedChangeOrderContribution[]>;
  /** Variance by_category groups by category *name* (operator-typed) but
   *  CO contributions are keyed by id. This map bridges the two. */
  categoryIdByName?: Record<string, string>;
}) {
  const {
    estimated_cents,
    lines_subtotal_cents,
    mgmt_fee_cents,
    envelope_total_cents,
    applied_co_impact_cents,
    pending_co_impact_cents,
    pending_co_count,
    committed_cents,
    committed_vendor_quotes_cents,
    committed_pos_cents,
    actual_bills_cents,
    actual_expenses_cents,
    actual_labour_cents,
    actual_total_cents,
    margin_at_risk_cents,
    by_category,
    mgmt_fee_rate,
    mgmt_fee_breakdown,
  } = variance;
  const envelopeGapCents = estimated_cents - envelope_total_cents;
  // Override map: applied COs with a per-CO rate set, keyed for badging
  // the per-CO row + the breakdown audit panel.
  const overrideByCoId = new Map(mgmt_fee_breakdown.co_overrides.map((o) => [o.co_id, o]));
  const hasOverrides = mgmt_fee_breakdown.co_overrides.length > 0;
  const projectRatePct = (mgmt_fee_rate * 100).toFixed(2).replace(/\.?0+$/, '');
  const effectiveRatePct = (mgmt_fee_breakdown.effective_rate * 100)
    .toFixed(2)
    .replace(/\.?0+$/, '');
  // Original signed scope = current lines minus what applied COs added.
  // Negative would mean applied COs net-removed scope; we still show it
  // as the pre-CO baseline so the operator sees the layering.
  const originalLinesCents = lines_subtotal_cents - applied_co_impact_cents;

  const isComplete = lifecycleStage === 'complete';

  const marginPct =
    estimated_cents > 0
      ? Math.round(((estimated_cents - actual_total_cents) / estimated_cents) * 100)
      : null;

  // For closed projects costs are settled — only flag danger when actually over budget.
  // For in-flight projects, warn at >80% of estimate.
  const isAtRisk = isComplete
    ? margin_at_risk_cents < 0
    : actual_total_cents > estimated_cents * 0.8;

  const marginPositive = margin_at_risk_cents > 0;
  const marginLabel = isComplete ? 'Realized Margin' : 'Margin at Risk';
  const marginSubLabel = isComplete ? 'final margin' : 'remaining margin';

  // Estimated stat sub-line shows the composition: lines subtotal + mgmt
  // fee, plus CO contribution if any have been applied.
  const coImpactCents = appliedChangeOrders.reduce((s, c) => s + c.cost_impact_cents, 0);
  const coCount = appliedChangeOrders.length;
  const estSubParts: string[] = [];
  if (lines_subtotal_cents > 0) {
    estSubParts.push(`Lines ${formatCurrency(lines_subtotal_cents)}`);
  }
  if (mgmt_fee_cents > 0) {
    estSubParts.push(`Mgmt fee ${formatCurrency(mgmt_fee_cents)}`);
  }
  if (coCount) {
    estSubParts.push(
      `${coImpactCents >= 0 ? '+' : ''}${formatCurrency(coImpactCents)} from ${coCount} CO${coCount === 1 ? '' : 's'}`,
    );
  }
  const estSub = estSubParts.length > 0 ? estSubParts.join(' · ') : undefined;

  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  function toggleRow(name: string) {
    setExpandedRow((cur) => (cur === name ? null : name));
  }

  return (
    <div className="space-y-6">
      {/* Top-level summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatBox
          label="Estimated Revenue"
          value={formatCurrency(estimated_cents)}
          sub={estSub}
          highlight
        />
        <StatBox label="Committed" value={formatCurrency(committed_cents)} />
        <StatBox
          label="Actual Cost"
          value={formatCurrency(actual_total_cents)}
          sub={[
            actual_labour_cents > 0 ? `Labour ${formatCurrency(actual_labour_cents)}` : null,
            actual_bills_cents > 0 ? `Bills ${formatCurrency(actual_bills_cents)}` : null,
            actual_expenses_cents > 0 ? `Expenses ${formatCurrency(actual_expenses_cents)}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
          danger={isAtRisk}
        />
        <StatBox
          label={marginLabel}
          value={formatCurrency(margin_at_risk_cents)}
          sub={marginPct !== null ? `${marginPct}% ${marginSubLabel}` : undefined}
          danger={margin_at_risk_cents < 0}
          success={isComplete && marginPositive}
        />
      </div>

      {margin_at_risk_cents < 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          Actual costs exceed estimated revenue — this job is over budget.
        </div>
      )}

      {/* Full composition — every dollar of revenue / committed / spent
          with its source. The top StatBoxes are the headlines; this is
          the audit trail. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <CompositionCard
          title="Revenue"
          tone="primary"
          rows={[
            ...(originalLinesCents !== 0
              ? [{ label: 'Original line items', value: originalLinesCents }]
              : []),
            ...appliedChangeOrders.map((c) => {
              const ov = overrideByCoId.get(c.id);
              const overridePct = ov
                ? (ov.override_rate * 100).toFixed(2).replace(/\.?0+$/, '')
                : null;
              return {
                label: ov
                  ? `Applied CO: ${c.title} (${overridePct}% fee)`
                  : `Applied CO: ${c.title}`,
                value: c.cost_impact_cents,
                href: projectId ? `/projects/${projectId}/change-orders/${c.id}` : undefined,
                badge: { kind: 'applied' as const },
              };
            }),
            ...(mgmt_fee_cents > 0
              ? hasOverrides
                ? [
                    {
                      label: `Management fee on baseline (${projectRatePct}%)`,
                      value: mgmt_fee_breakdown.baseline_fee_cents,
                    },
                    ...mgmt_fee_breakdown.co_overrides.map((o) => {
                      const co = appliedChangeOrders.find((c) => c.id === o.co_id);
                      const ratePct = (o.override_rate * 100).toFixed(2).replace(/\.?0+$/, '');
                      return {
                        label: `Management fee on ${co?.title ?? 'CO'} (${ratePct}% override)`,
                        value: o.fee_cents,
                      };
                    }),
                  ]
                : [{ label: `Management fee (${projectRatePct}%)`, value: mgmt_fee_cents }]
              : []),
          ]}
          total={{ label: 'Estimated revenue', value: estimated_cents }}
          footer={
            hasOverrides ? (
              <p className="text-xs text-muted-foreground">
                Effective management fee: <span className="font-medium">{effectiveRatePct}%</span>{' '}
                (project default {projectRatePct}%).
              </p>
            ) : null
          }
          extraSection={(() => {
            const legacy = allChangeOrders.filter((c) => c.revenue_kind === 'approved_legacy');
            const pending = allChangeOrders.filter((c) => c.revenue_kind === 'pending');
            if (legacy.length === 0 && pending.length === 0) return null;
            return (
              <div className="mt-3 space-y-2 border-t pt-3 text-xs">
                {legacy.length > 0 ? (
                  <div>
                    <p className="font-semibold text-amber-800">
                      Approved but not applied to lines
                    </p>
                    <ul className="mt-1 space-y-1">
                      {legacy.map((c) => (
                        <li key={c.id} className="flex items-baseline justify-between gap-3">
                          <a
                            href={projectId ? `/projects/${projectId}/change-orders/${c.id}` : '#'}
                            className="flex flex-1 items-baseline justify-between gap-2 hover:underline"
                          >
                            <span>
                              <span className="mr-1.5 inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800">
                                {c.flow_version === 1 ? 'v1' : 'unapplied'}
                              </span>
                              {c.title}
                            </span>
                            <span className="tabular-nums font-medium text-amber-900">
                              {c.cost_impact_cents >= 0 ? '+' : ''}
                              {formatCurrency(c.cost_impact_cents)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 italic text-muted-foreground">
                      Customer agreed to these but cost lines may not reflect them. Verify line
                      items match the agreed scope.
                    </p>
                  </div>
                ) : null}
                {pending.length > 0 ? (
                  <div>
                    <p className="font-semibold text-muted-foreground">Pending customer approval</p>
                    <ul className="mt-1 space-y-1">
                      {pending.map((c) => (
                        <li key={c.id} className="flex items-baseline justify-between gap-3">
                          <a
                            href={projectId ? `/projects/${projectId}/change-orders/${c.id}` : '#'}
                            className="flex flex-1 items-baseline justify-between gap-2 italic hover:underline"
                          >
                            <span>{c.title}</span>
                            <span className="tabular-nums">
                              {c.cost_impact_cents >= 0 ? '+' : ''}
                              {formatCurrency(c.cost_impact_cents)}
                            </span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            );
          })()}
        />
        <CompositionCard
          title="Committed"
          rows={[
            ...(committed_vendor_quotes_cents > 0
              ? [
                  {
                    label: 'Accepted vendor quotes',
                    value: committed_vendor_quotes_cents,
                    href: projectId ? `/projects/${projectId}?tab=costs&sub=quotes` : undefined,
                  },
                ]
              : []),
            ...(committed_pos_cents > 0
              ? [
                  {
                    label: 'Active purchase orders',
                    value: committed_pos_cents,
                    href: projectId ? `/projects/${projectId}?tab=costs&sub=pos` : undefined,
                  },
                ]
              : []),
          ]}
          total={{ label: 'Total committed', value: committed_cents }}
          footer={
            committed_cents === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No vendor quotes accepted or active POs yet.
              </p>
            ) : null
          }
        />
        <CompositionCard
          title="Spent"
          tone={isAtRisk ? 'danger' : undefined}
          rows={[
            ...(actual_labour_cents > 0
              ? [
                  {
                    label: 'Labour (time entries)',
                    value: actual_labour_cents,
                    href: projectId ? `/projects/${projectId}?tab=time` : undefined,
                  },
                ]
              : []),
            ...(actual_bills_cents > 0
              ? [
                  {
                    label: 'Bills',
                    value: actual_bills_cents,
                    href: projectId ? `/projects/${projectId}?tab=costs&sub=bills` : undefined,
                  },
                ]
              : []),
            ...(actual_expenses_cents > 0
              ? [
                  {
                    label: 'Expenses',
                    value: actual_expenses_cents,
                    href: projectId ? `/projects/${projectId}?tab=costs&sub=expenses` : undefined,
                  },
                ]
              : []),
          ]}
          total={{ label: 'Total spent', value: actual_total_cents }}
          footer={
            actual_total_cents === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No labour, bills, or expenses logged yet.
              </p>
            ) : null
          }
        />
      </div>

      {/* By-category breakdown — read-only. Click a row to expand the
          bills/expenses/POs/quotes split that drove the actuals. */}
      {by_category.length > 0 && (
        <div>
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold">By Category (operator budget envelope)</h3>
            <span className="text-xs text-muted-foreground">
              Sums to {formatCurrency(envelope_total_cents)}
              {envelopeGapCents !== 0 ? (
                <>
                  {' '}
                  · {envelopeGapCents > 0 ? '+' : ''}
                  {formatCurrency(envelopeGapCents)} vs revenue
                </>
              ) : null}
            </span>
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="w-8 px-2 py-2" />
                  <th className="px-3 py-2 text-left font-medium">Category</th>
                  <th className="px-3 py-2 text-right font-medium">Estimated</th>
                  <th className="px-3 py-2 text-right font-medium">Committed</th>
                  <th className="px-3 py-2 text-right font-medium">Actual</th>
                  <th className="px-3 py-2 text-right font-medium">Margin Left</th>
                </tr>
              </thead>
              <tbody>
                {by_category.map((row) => {
                  const isOpen = expandedRow === row.category;
                  const catId = categoryIdByName[row.category];
                  const contribs = catId ? (coContributionsByCategoryId[catId] ?? []) : [];
                  const coChips = Array.from(new Map(contribs.map((c) => [c.co_id, c])).values());
                  return (
                    <Fragment key={row.category}>
                      <tr
                        className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                        onClick={() => toggleRow(row.category)}
                      >
                        <td className="px-2 py-2 align-top text-muted-foreground">
                          {isOpen ? (
                            <ChevronDown className="size-4" />
                          ) : (
                            <ChevronRight className="size-4" />
                          )}
                        </td>
                        <td className="px-3 py-2 capitalize font-medium">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span>{row.category}</span>
                            {coChips.map((c) => (
                              <a
                                key={c.co_id}
                                href={`/projects/${projectId}/change-orders/${c.co_id}`}
                                onClick={(e) => e.stopPropagation()}
                                title={`Touched by CO: ${c.co_title}`}
                                className="inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-800 hover:bg-blue-200"
                              >
                                CO {c.co_short_id}
                              </a>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right">
                          {formatCurrency(row.estimated_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {formatCurrency(row.committed_cents)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">
                          {formatCurrency(row.actual_cents)}
                        </td>
                        <td
                          className={`px-3 py-2 text-right font-medium ${row.margin_at_risk_cents < 0 ? 'text-destructive' : ''}`}
                        >
                          {formatCurrency(row.margin_at_risk_cents)}
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="border-b bg-muted/20 last:border-0">
                          <td />
                          <td colSpan={5} className="px-3 py-3 text-xs">
                            <CategoryBreakdown
                              row={row}
                              projectId={projectId}
                              budgetCategoryId={catId}
                              coContributions={contribs}
                            />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
                <tr className="border-t bg-muted/30 font-semibold">
                  <td />
                  <td className="px-3 py-2">Envelope Total</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(envelope_total_cents)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(committed_cents)}</td>
                  <td className="px-3 py-2 text-right">{formatCurrency(actual_total_cents)}</td>
                  <td
                    className={`px-3 py-2 text-right ${envelope_total_cents - actual_total_cents - committed_cents < 0 ? 'text-destructive' : 'text-primary'}`}
                  >
                    {formatCurrency(envelope_total_cents - actual_total_cents - committed_cents)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {estimated_cents === 0 && actual_total_cents === 0 && (
        <p className="text-sm text-muted-foreground">
          No line items or bills recorded yet. Add line items in the Budget tab and log bills in the
          Spend tab.
        </p>
      )}
    </div>
  );
}

type CompositionRow = {
  label: string;
  value: number;
  href?: string;
  muted?: boolean;
  badge?: { kind: 'applied' };
};

function CompositionCard({
  title,
  tone,
  rows,
  total,
  footer,
  extraSection,
}: {
  title: string;
  tone?: 'primary' | 'danger';
  rows: CompositionRow[];
  total: { label: string; value: number };
  footer?: React.ReactNode;
  /** Optional extra block rendered between the total and the footer.
   *  Used for surfacing approved-but-not-applied / pending COs in the
   *  Revenue card without polluting the running total. */
  extraSection?: React.ReactNode;
}) {
  const totalToneClass =
    tone === 'danger' ? 'text-destructive' : tone === 'primary' ? 'text-primary' : '';
  return (
    <div className="rounded-lg border bg-background p-4">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {rows.length > 0 ? (
        <ul className="space-y-1.5 text-sm">
          {rows.map((r) => {
            const content = (
              <>
                <span className={r.muted ? 'text-muted-foreground' : ''}>{r.label}</span>
                <span
                  className={`tabular-nums ${r.muted ? 'text-muted-foreground' : 'font-medium'}`}
                >
                  {r.value >= 0 ? '' : '−'}
                  {formatCurrency(Math.abs(r.value))}
                </span>
              </>
            );
            return (
              <li key={r.label} className="flex items-baseline justify-between gap-3">
                {r.href ? (
                  <a
                    href={r.href}
                    className="flex flex-1 items-baseline justify-between gap-3 hover:underline"
                  >
                    {content}
                  </a>
                ) : (
                  content
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div
        className={`${rows.length > 0 ? 'mt-3 border-t pt-2' : ''} flex items-baseline justify-between gap-3 text-sm`}
      >
        <span className="font-semibold">{total.label}</span>
        <span className={`text-base font-semibold tabular-nums ${totalToneClass}`}>
          {formatCurrency(total.value)}
        </span>
      </div>
      {extraSection}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </div>
  );
}

function CategoryBreakdown({
  row,
  projectId,
  budgetCategoryId,
  coContributions,
}: {
  row: VarianceData['by_category'][number];
  projectId?: string;
  budgetCategoryId?: string;
  coContributions: AppliedChangeOrderContribution[];
}) {
  const linkBase = projectId ? `/projects/${projectId}` : null;
  const focus = budgetCategoryId ? `&focus=${budgetCategoryId}` : '';
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <BreakdownStat label="Estimated" value={formatCurrency(row.estimated_cents)} />
        <BreakdownStat label="Committed" value={formatCurrency(row.committed_cents)} />
        <BreakdownStat label="Actual" value={formatCurrency(row.actual_cents)} />
        <BreakdownStat
          label="Margin Left"
          value={formatCurrency(row.margin_at_risk_cents)}
          danger={row.margin_at_risk_cents < 0}
        />
      </div>
      {coContributions.length > 0 ? (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Change Orders affecting this category
          </p>
          <ul className="space-y-1">
            {Array.from(new Map(coContributions.map((c) => [c.co_id, c])).values()).map((c) => (
              <li key={c.co_id} className="flex items-baseline justify-between gap-2">
                <a
                  href={linkBase ? `${linkBase}/change-orders/${c.co_id}` : '#'}
                  className="hover:underline"
                >
                  <span className="mr-1.5 inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-800">
                    CO {c.co_short_id}
                  </span>
                  {c.co_title}
                </a>
                <span className="text-muted-foreground tabular-nums">
                  {new Date(c.applied_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {linkBase ? (
        <div className="flex flex-wrap gap-3 pt-1 text-[11px]">
          <a className="text-primary hover:underline" href={`${linkBase}?tab=budget${focus}`}>
            Open in Budget →
          </a>
          <a
            className="text-primary hover:underline"
            href={`${linkBase}?tab=costs&sub=bills${focus}`}
          >
            Bills →
          </a>
          <a
            className="text-primary hover:underline"
            href={`${linkBase}?tab=costs&sub=expenses${focus}`}
          >
            Expenses →
          </a>
          <a
            className="text-primary hover:underline"
            href={`${linkBase}?tab=costs&sub=pos${focus}`}
          >
            POs →
          </a>
          <a className="text-primary hover:underline" href={`${linkBase}?tab=time${focus}`}>
            Time →
          </a>
        </div>
      ) : null}
    </div>
  );
}

function BreakdownStat({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded border bg-background px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-sm font-medium tabular-nums ${danger ? 'text-destructive' : ''}`}>
        {value}
      </p>
    </div>
  );
}
