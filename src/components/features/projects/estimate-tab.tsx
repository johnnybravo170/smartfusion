'use client';

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
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
  bucketsById,
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
  bucketsById: Record<string, { name: string; section: string | null; order: number }>;
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

  // Group by bucket, then nest buckets under their section so the section
  // label is rendered once as a top-level header rather than repeated on
  // every bucket.
  type BucketGroup = {
    key: string;
    bucketName: string;
    order: number;
    lines: CostLineRow[];
  };
  type SectionGroup = {
    key: string;
    section: string | null;
    order: number;
    buckets: BucketGroup[];
  };
  const bucketMap = new Map<string, BucketGroup & { section: string | null }>();
  for (const line of costLines) {
    const key = line.budget_category_id ?? '__none__';
    const info = line.budget_category_id ? bucketsById[line.budget_category_id] : undefined;
    const g = bucketMap.get(key) ?? {
      key,
      bucketName: info?.name ?? 'Other',
      section: info?.section ?? null,
      order: info?.order ?? Number.MAX_SAFE_INTEGER,
      lines: [],
    };
    g.lines.push(line);
    bucketMap.set(key, g);
  }
  const sectionMap = new Map<string, SectionGroup>();
  for (const b of bucketMap.values()) {
    const sKey = b.section ?? '__none__';
    const s = sectionMap.get(sKey) ?? {
      key: sKey,
      section: b.section,
      order: b.order,
      buckets: [],
    };
    s.buckets.push({ key: b.key, bucketName: b.bucketName, order: b.order, lines: b.lines });
    s.order = Math.min(s.order, b.order);
    sectionMap.set(sKey, s);
  }
  const sections = Array.from(sectionMap.values())
    .map((s) => ({ ...s, buckets: s.buckets.sort((a, b) => a.order - b.order) }))
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
          {approval.status === 'pending_approval' ? (
            <>
              <Button size="sm" variant="outline" onClick={copyApprovalLink}>
                Copy link
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => router.push(`/projects/${projectId}/estimate/preview`)}
              >
                Preview &amp; resend
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
                    {sec.buckets.flatMap(({ lines }) =>
                      lines.map((line) => {
                        const photos = (line.photo_storage_paths ?? [])
                          .map((path) => ({
                            path,
                            url: costLinePhotoUrls[path] ?? '',
                          }))
                          .filter((p) => p.url);
                        return (
                          <Fragment key={line.id}>
                            <tr className="align-top border-b last:border-0">
                              <td className="px-3 py-2">
                                <p className="font-medium">{line.label}</p>
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
