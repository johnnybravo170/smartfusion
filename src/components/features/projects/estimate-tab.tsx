'use client';

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { AppliedChangeOrderContribution } from '@/lib/db/queries/change-orders';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { withFrom } from '@/lib/nav/from-link';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  type ManualApprovalMethod,
  manualApprovalMethodLabels,
} from '@/lib/validators/manual-approval';
import { resetEstimateAction } from '@/server/actions/estimate-approval';
import { createInvoiceFromEstimateAction } from '@/server/actions/invoices';
import { CostLinePhotoStrip } from './cost-line-photo-strip';
import { EstimateFeedbackCard, type FeedbackRow } from './estimate-feedback-card';
import { ManualApprovalDialog } from './manual-approval-dialog';

export type EstimateApprovalInfo = {
  status: 'draft' | 'pending_approval' | 'approved' | 'declined';
  approval_code: string | null;
  sent_at: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  declined_at: string | null;
  declined_reason: string | null;
  view_count: number;
  last_viewed_at: string | null;
  /** Manual-override fields; `method` is null for legacy digital approvals. */
  approval_method: string | null;
  approval_notes: string | null;
  approval_proof_paths: string[];
  approval_proof_signed_urls: Record<string, string>;
};

export function EstimateTab({
  projectId,
  costLines,
  managementFeeRate,
  approval,
  costLinePhotoUrls,
  feedback,
  categoriesById,
  coContributionsByLineId = {},
  appliedChangeOrders = [],
}: {
  projectId: string;
  costLines: CostLineRow[];
  /**
   * Materials catalog. Unused inline since 2026-04-27 — Estimate became
   * read-only on line items and edits were moved to the Budget tab. Kept
   * in props in case the aggressive Build/Preview merge lands later.
   */
  catalog: MaterialsCatalogRow[];
  managementFeeRate: number;
  approval: EstimateApprovalInfo;
  costLinePhotoUrls: Record<string, string>;
  feedback: FeedbackRow[];
  categoriesById: Record<string, { name: string; section: string | null; order: number }>;
  /** Audit lens: which applied COs touched each line. Empty by default
   *  for projects with no v2 COs. */
  coContributionsByLineId?: Record<string, AppliedChangeOrderContribution[]>;
  appliedChangeOrders?: {
    id: string;
    title: string;
    short_id: string;
    applied_at: string;
    cost_impact_cents: number;
  }[];
}) {
  const [manualDialog, setManualDialog] = useState<{
    open: boolean;
    mode: 'approve' | 'decline';
  }>({ open: false, mode: 'approve' });
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function createInvoice() {
    startTransition(async () => {
      const res = await createInvoiceFromEstimateAction({ projectId });
      if (res.ok && res.id) {
        toast.success('Invoice created');
        router.push(`/invoices/${res.id}`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  function resetEstimate() {
    if (!confirm('Reset estimate to draft? The approval link will be invalidated.')) return;
    startTransition(async () => {
      const res = await resetEstimateAction({ projectId });
      if (res.ok) {
        toast.success('Estimate reset to draft');
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function copyApprovalLink() {
    if (!approval.approval_code) return;
    const url = `${window.location.origin}/estimate/${approval.approval_code}`;
    navigator.clipboard.writeText(url).then(() => toast.success('Link copied'));
  }

  const totalCost = costLines.reduce((s, l) => s + l.line_cost_cents, 0);
  const totalPrice = costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFeeCents = Math.round(totalPrice * managementFeeRate);
  const grandTotal = totalPrice + mgmtFeeCents;

  // Running total impact from applied COs (already baked into cost_lines /
  // budget_categories — surfaced as audit context only).
  const totalAppliedCoImpactCents = appliedChangeOrders.reduce(
    (s, c) => s + c.cost_impact_cents,
    0,
  );

  // Group by category, then nest categories under their section so the section
  // label is rendered once as a top-level header rather than repeated on
  // every category.
  type CategoryGroup = {
    key: string;
    categoryName: string;
    order: number;
    lines: CostLineRow[];
  };
  type SectionGroup = {
    key: string;
    section: string | null;
    order: number;
    categories: CategoryGroup[];
  };
  const categoryMap = new Map<string, CategoryGroup & { section: string | null }>();
  for (const line of costLines) {
    const key = line.budget_category_id ?? '__none__';
    const info = line.budget_category_id ? categoriesById[line.budget_category_id] : undefined;
    const g = categoryMap.get(key) ?? {
      key,
      categoryName: info?.name ?? 'Other',
      section: info?.section ?? null,
      order: info?.order ?? Number.MAX_SAFE_INTEGER,
      lines: [],
    };
    g.lines.push(line);
    categoryMap.set(key, g);
  }
  const sectionMap = new Map<string, SectionGroup>();
  for (const b of categoryMap.values()) {
    const sKey = b.section ?? '__none__';
    const s = sectionMap.get(sKey) ?? {
      key: sKey,
      section: b.section,
      order: b.order,
      categories: [],
    };
    s.categories.push({ key: b.key, categoryName: b.categoryName, order: b.order, lines: b.lines });
    s.order = Math.min(s.order, b.order);
    sectionMap.set(sKey, s);
  }
  const sections = Array.from(sectionMap.values())
    .map((s) => ({ ...s, categories: s.categories.sort((a, b) => a.order - b.order) }))
    .sort((a, b) => a.order - b.order);

  const statusChip = (() => {
    switch (approval.status) {
      case 'approved':
        return (
          <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
            Approved
          </span>
        );
      case 'pending_approval':
        return (
          <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            Awaiting approval
          </span>
        );
      case 'declined':
        return (
          <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
            Declined
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Draft
          </span>
        );
    }
  })();

  return (
    <div className="space-y-4">
      <EstimateFeedbackCard projectId={projectId} feedback={feedback} />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-3">
          {statusChip}
          {approval.status === 'pending_approval' ? (
            <span className="text-xs text-muted-foreground">
              Sent{' '}
              {approval.sent_at
                ? new Date(approval.sent_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                  })
                : ''}{' '}
              · {approval.view_count} view{approval.view_count === 1 ? '' : 's'}
              {approval.last_viewed_at
                ? ` · last ${new Date(approval.last_viewed_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                  })}`
                : ' · not opened yet'}
            </span>
          ) : null}
          {approval.status === 'approved' && approval.approved_by_name ? (
            <span className="text-xs text-muted-foreground">
              by {approval.approved_by_name}
              {approval.approved_at
                ? ` on ${new Date(approval.approved_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                  })}`
                : ''}
            </span>
          ) : null}
          {approval.status === 'declined' && approval.declined_reason ? (
            <span className="text-xs text-muted-foreground">— {approval.declined_reason}</span>
          ) : null}
        </div>
        <div className="flex gap-2">
          {approval.status === 'draft' && costLines.length > 0 ? (
            <Button
              size="sm"
              onClick={() => router.push(`/projects/${projectId}/estimate/preview`)}
            >
              Preview &amp; send
            </Button>
          ) : null}
          {/*
           * Copy link + Preview/Resend stay available after the estimate
           * lands in pending/approved/declined — operator may need to
           * forward the link again, or resend the email if the customer
           * lost it. The customer-facing page reads live state so any
           * post-approval line detail additions show up automatically
           * (totals unchanged → still the approved estimate).
           */}
          {approval.status === 'pending_approval' ||
          approval.status === 'approved' ||
          approval.status === 'declined' ? (
            <>
              <Button size="sm" variant="outline" onClick={copyApprovalLink}>
                Copy link
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/projects/${projectId}/estimate/preview`)}
              >
                Preview &amp; {approval.status === 'pending_approval' ? 'resend' : 'share'}
              </Button>
            </>
          ) : null}
          {/*
           * Manual override — customer said yes/no off-platform, or operator
           * is backfilling an imported / historical project. Available in
           * draft (with cost lines) and pending_approval. The dialog warns
           * the operator when triggered from draft (no customer notification).
           */}
          {approval.status === 'pending_approval' ||
          (approval.status === 'draft' && costLines.length > 0) ? (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManualDialog({ open: true, mode: 'approve' })}
              >
                Mark approved
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setManualDialog({ open: true, mode: 'decline' })}
              >
                Mark declined
              </Button>
            </>
          ) : null}
          {approval.status === 'pending_approval' ? (
            <Button size="sm" variant="ghost" onClick={resetEstimate} disabled={isPending}>
              Reset
            </Button>
          ) : null}
          {approval.status === 'approved' || approval.status === 'declined' ? (
            <Button size="sm" variant="ghost" onClick={resetEstimate} disabled={isPending}>
              Reset to draft
            </Button>
          ) : null}
        </div>
      </div>

      {approval.approval_method && approval.approval_method !== 'digital' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-800 dark:bg-amber-950/20">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Manual override</p>
          <p className="mt-1 text-sm">
            Recorded via{' '}
            <span className="font-medium">
              {manualApprovalMethodLabels[approval.approval_method as ManualApprovalMethod] ??
                approval.approval_method}
            </span>
            .
          </p>
          {approval.approval_notes ? (
            <p className="mt-2 whitespace-pre-wrap text-sm">{approval.approval_notes}</p>
          ) : null}
          {approval.approval_proof_paths.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1 text-xs text-muted-foreground">Proof</p>
              <ul className="flex flex-wrap gap-2">
                {approval.approval_proof_paths.map((p) => {
                  const url = approval.approval_proof_signed_urls[p];
                  const name = p.split('/').pop() ?? p;
                  return (
                    <li key={p}>
                      {url ? (
                        <a
                          href={url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs hover:bg-muted"
                        >
                          {name}
                        </a>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                          {name}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Estimate is read-only on line items. Editing happens in the Budget
          tab so there's a single source of truth — discoverability dies
          when both surfaces accept edits. */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        <span>Line items are edited in the Budget tab.</span>
        <Button asChild size="sm" variant="outline">
          <Link href={`/projects/${projectId}?tab=budget`}>
            <Pencil className="size-3.5" />
            Open Budget
          </Link>
        </Button>
      </div>

      {appliedChangeOrders.length > 0 ? (
        <div className="rounded-lg border bg-blue-50/40 px-4 py-3 dark:bg-blue-950/20">
          <div className="mb-2 flex items-baseline justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-blue-900 dark:text-blue-200">
              Change Order history
            </h3>
            <span className="text-xs text-blue-900/80 dark:text-blue-200/80 tabular-nums">
              {appliedChangeOrders.length} applied
              {totalAppliedCoImpactCents !== 0 ? (
                <>
                  {' · '}
                  {totalAppliedCoImpactCents >= 0 ? '+' : ''}
                  {formatCurrency(totalAppliedCoImpactCents)}
                </>
              ) : null}
            </span>
          </div>
          <ul className="space-y-1 text-sm">
            {appliedChangeOrders.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline justify-between gap-3 rounded border border-blue-100 bg-background/60 px-2 py-1.5 dark:border-blue-900"
              >
                <Link
                  href={withFrom(
                    `/projects/${projectId}/change-orders/${c.id}`,
                    `/projects/${projectId}?tab=budget`,
                    'Budget',
                  )}
                  className="min-w-0 flex-1 truncate hover:underline"
                >
                  <span className="mr-2 inline-flex items-center rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-blue-800">
                    CO {c.short_id}
                  </span>
                  {c.title}
                </Link>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(c.applied_at).toLocaleDateString('en-CA', {
                    month: 'short',
                    day: 'numeric',
                  })}
                </span>
                <span
                  className={`shrink-0 text-sm font-medium tabular-nums ${c.cost_impact_cents < 0 ? 'text-emerald-700' : ''}`}
                >
                  {c.cost_impact_cents >= 0 ? '+' : ''}
                  {formatCurrency(c.cost_impact_cents)}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            CO changes are folded into the line items and category budgets above. Tap a CO chip on
            any line to jump to that change order.
          </p>
        </div>
      ) : null}

      {costLines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No line items yet.{' '}
          <Link href={`/projects/${projectId}?tab=budget`} className="text-foreground underline">
            Add your first item in Budget
          </Link>
          .
        </p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-md border">
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-24" />
                <col className="w-28" />
                <col className="w-20" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Markup</th>
                </tr>
              </thead>
              <tbody>
                {sections.map((sec) => (
                  <Fragment key={sec.key}>
                    {sec.section ? (
                      <tr className="border-b bg-muted/30">
                        <td
                          colSpan={4}
                          className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {sec.section}
                        </td>
                      </tr>
                    ) : null}
                    {sec.categories.flatMap(({ lines }) =>
                      lines.map((line) => {
                        const photos = (line.photo_storage_paths ?? [])
                          .map((path) => ({
                            path,
                            url: costLinePhotoUrls[path] ?? '',
                          }))
                          .filter((p) => p.url);
                        const lineContribs = coContributionsByLineId[line.id] ?? [];
                        return (
                          <Fragment key={line.id}>
                            <tr className="align-top border-b last:border-0">
                              <td className="px-3 py-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <p className="font-medium">{line.label}</p>
                                  {lineContribs.map((c) => (
                                    <Link
                                      key={`${c.co_id}:${c.action}`}
                                      href={withFrom(
                                        `/projects/${projectId}/change-orders/${c.co_id}`,
                                        `/projects/${projectId}?tab=budget`,
                                        'Budget',
                                      )}
                                      title={`${c.action === 'add' ? 'Added' : 'Modified'} by CO: ${c.co_title}`}
                                      className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-800 hover:bg-blue-200"
                                    >
                                      CO {c.co_short_id}
                                    </Link>
                                  ))}
                                </div>
                                {line.notes ? (
                                  <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">
                                    {line.notes}
                                  </p>
                                ) : null}
                                <CostLinePhotoStrip
                                  costLineId={line.id}
                                  projectId={projectId}
                                  showAddButton={false}
                                  photos={photos}
                                />
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground">
                                {formatCurrency(line.line_cost_cents)}
                              </td>
                              <td className="px-3 py-2 text-right font-medium">
                                {formatCurrency(line.line_price_cents)}
                              </td>
                              <td className="px-3 py-2 text-right text-muted-foreground">
                                {Number(line.markup_pct).toFixed(1)}%
                              </td>
                            </tr>
                          </Fragment>
                        );
                      }),
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm">
            <div className="flex justify-end gap-8">
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Subtotal</p>
                <p className="font-medium">{formatCurrency(totalPrice)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">
                  Management fee ({Math.round(managementFeeRate * 100)}%)
                </p>
                <p className="font-medium">{formatCurrency(mgmtFeeCents)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted-foreground">Total</p>
                <p className="font-semibold text-primary">{formatCurrency(grandTotal)}</p>
              </div>
              {totalCost > 0 && (
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Gross Margin</p>
                  <p className="font-medium">
                    {Math.round(((totalPrice - totalCost) / totalPrice) * 100)}%
                  </p>
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center justify-end gap-3">
              {approval.status !== 'approved' ? (
                <p className="text-xs text-muted-foreground">
                  Customer must approve the estimate before invoicing.
                </p>
              ) : null}
              <Button
                size="sm"
                onClick={createInvoice}
                disabled={isPending || approval.status !== 'approved'}
              >
                Create invoice from estimate
              </Button>
            </div>
          </div>
        </div>
      )}

      <ManualApprovalDialog
        open={manualDialog.open}
        onOpenChange={(o) => setManualDialog((d) => ({ ...d, open: o }))}
        resourceType="estimate"
        resourceId={projectId}
        mode={manualDialog.mode}
        bypassedSend={approval.status === 'draft'}
        onSuccess={() => {
          toast.success(
            manualDialog.mode === 'approve'
              ? 'Estimate marked approved'
              : 'Estimate marked declined',
          );
          router.refresh();
        }}
      />
    </div>
  );
}
