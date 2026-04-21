'use client';

import { useRouter } from 'next/navigation';
import { Fragment, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { CostLineRow } from '@/lib/db/queries/cost-lines';
import type { MaterialsCatalogRow } from '@/lib/db/queries/materials-catalog';
import { formatCurrency } from '@/lib/pricing/calculator';
import { resetEstimateAction } from '@/server/actions/estimate-approval';
import { createInvoiceFromEstimateAction } from '@/server/actions/invoices';
import { deleteCostLineAction } from '@/server/actions/project-cost-control';
import { CostLineForm } from './cost-line-form';
import { CostLinePhotoStrip } from './cost-line-photo-strip';
import { EstimateFeedbackCard, type FeedbackRow } from './estimate-feedback-card';

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
};

export function EstimateTab({
  projectId,
  costLines,
  catalog,
  managementFeeRate,
  approval,
  costLinePhotoUrls,
  feedback,
  bucketsById,
}: {
  projectId: string;
  costLines: CostLineRow[];
  catalog: MaterialsCatalogRow[];
  managementFeeRate: number;
  approval: EstimateApprovalInfo;
  costLinePhotoUrls: Record<string, string>;
  feedback: FeedbackRow[];
  bucketsById: Record<string, { name: string; section: string | null; order: number }>;
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingLine, setEditingLine] = useState<CostLineRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function deleteLine(id: string) {
    if (!confirm('Delete this line?')) return;
    startTransition(async () => {
      await deleteCostLineAction(id, projectId);
    });
  }

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
    const key = line.bucket_id ?? '__none__';
    const info = line.bucket_id ? bucketsById[line.bucket_id] : undefined;
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
              <Button size="sm" variant="ghost" onClick={resetEstimate} disabled={isPending}>
                Reset
              </Button>
            </>
          ) : null}
          {approval.status === 'approved' || approval.status === 'declined' ? (
            <Button size="sm" variant="ghost" onClick={resetEstimate} disabled={isPending}>
              Reset to draft
            </Button>
          ) : null}
        </div>
      </div>

      {/* Top-anchored form is for Add only. Edit happens inline inside the
          row below so the operator keeps their scroll position. */}
      {showForm ? (
        <CostLineForm projectId={projectId} catalog={catalog} onDone={() => setShowForm(false)} />
      ) : (
        <Button size="sm" onClick={() => setShowForm(true)}>
          + Add line
        </Button>
      )}

      {costLines.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No cost lines yet. Add your first item above.
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
                <col className="w-24" />
              </colgroup>
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Cost</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">Markup</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {sections.map((sec) => (
                  <Fragment key={sec.key}>
                    {sec.section ? (
                      <tr className="border-b bg-muted/30">
                        <td
                          colSpan={5}
                          className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                        >
                          {sec.section}
                        </td>
                      </tr>
                    ) : null}
                    {sec.buckets.flatMap(({ lines }) =>
                      lines.map((line) => {
                        const isEditing = editingLine?.id === line.id;
                        const photos = (line.photo_storage_paths ?? [])
                          .map((path) => ({
                            path,
                            url: costLinePhotoUrls[path] ?? '',
                          }))
                          .filter((p) => p.url);
                        return (
                          <Fragment key={line.id}>
                            <tr
                              className={
                                isEditing ? 'align-top' : 'align-top border-b last:border-0'
                              }
                            >
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
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => {
                                      setEditingLine(isEditing ? null : line);
                                      setShowForm(false);
                                    }}
                                  >
                                    {isEditing ? 'Close' : 'Edit'}
                                  </Button>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() => deleteLine(line.id)}
                                  >
                                    Del
                                  </Button>
                                </div>
                              </td>
                            </tr>
                            {isEditing ? (
                              <tr className="border-b bg-muted/30">
                                <td colSpan={5} className="p-4">
                                  <CostLineForm
                                    projectId={projectId}
                                    initial={line}
                                    catalog={catalog}
                                    photoUrls={costLinePhotoUrls}
                                    onDone={() => setEditingLine(null)}
                                  />
                                </td>
                              </tr>
                            ) : null}
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
    </div>
  );
}
