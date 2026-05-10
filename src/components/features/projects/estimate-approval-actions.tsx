'use client';

/**
 * Approval-state surface on the Budget tab.
 *
 * Was the contents of the orphaned `EstimateTab` after the unified-Budget
 * refactor (decision 6790ef2b) folded the old Estimate / Change Orders /
 * Budget tabs into one. The line-item table moved into BudgetCategoriesTable;
 * this component owns the things that didn't have a home in the new shell:
 *
 *   - "Mark approved" / "Mark declined" buttons (off-platform approvals)
 *   - "Reset to draft" — for revising a sent estimate
 *   - "Copy approval link" — operator quality of life
 *   - "Create invoice from estimate" — the post-approval entry into the
 *     invoicing flow
 *   - Declined-state banner with reason (no other UI showed this)
 *   - Manual-override metadata (method / notes / proof file links)
 *
 * Hidden when the estimate is still in `draft` AND has no cost lines —
 * there's nothing meaningful to surface. Once the operator adds lines or
 * sends the estimate, the component renders so they can switch to a
 * manual approval if needed (e.g. customer said yes by phone).
 */

import { Pencil } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import {
  type ManualApprovalMethod,
  manualApprovalMethodLabels,
} from '@/lib/validators/manual-approval';
import { resetEstimateAction } from '@/server/actions/estimate-approval';
import { createInvoiceFromEstimateAction } from '@/server/actions/invoices';
import { ManualApprovalDialog } from './manual-approval-dialog';

type ApprovalStatus = 'draft' | 'pending_approval' | 'approved' | 'declined' | string;

type Props = {
  projectId: string;
  status: ApprovalStatus;
  approvalCode: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  declinedAt: string | null;
  declinedReason: string | null;
  approvalMethod: string | null;
  approvalNotes: string | null;
  approvalProofPaths: string[];
  approvalProofSignedUrls: Record<string, string>;
  /** Used to gate "Mark approved/declined" — refuses on a totally empty draft. */
  costLineCount: number;
};

export function EstimateApprovalActions({
  projectId,
  status,
  approvalCode,
  approvedByName,
  approvedAt,
  declinedAt,
  declinedReason,
  approvalMethod,
  approvalNotes,
  approvalProofPaths,
  approvalProofSignedUrls,
  costLineCount,
}: Props) {
  const router = useRouter();
  const tz = useTenantTimezone();
  const [isPending, startTransition] = useTransition();
  const [manualDialog, setManualDialog] = useState<{
    open: boolean;
    mode: 'approve' | 'decline';
  }>({ open: false, mode: 'approve' });

  function copyApprovalLink() {
    if (!approvalCode) return;
    const url = `${window.location.origin}/estimate/${approvalCode}`;
    navigator.clipboard.writeText(url).then(() => toast.success('Link copied'));
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

  const canMarkApproval =
    status === 'pending_approval' || (status === 'draft' && costLineCount > 0);
  const canCopyOrPreview =
    status === 'pending_approval' || status === 'approved' || status === 'declined';
  const canReset = status === 'pending_approval' || status === 'approved' || status === 'declined';
  const canCreateInvoice = status === 'approved';

  // Nothing to surface on a totally fresh draft (no lines, no history).
  // Mark approved/declined needs costLineCount > 0; everything else needs
  // a non-draft status.
  if (!canMarkApproval && !canCopyOrPreview) return null;

  const formatDate = (iso: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));

  return (
    <div className="flex flex-col gap-3">
      {/* Approved-state line: who signed + when. The pending state has its
       *  own EstimateSentBanner; the approved state has AppliedChangeOrdersBanner.
       *  Declined has nothing else, so we surface that here. */}
      {status === 'approved' && approvedByName ? (
        <p className="text-xs text-muted-foreground">
          Approved by {approvedByName}
          {approvedAt ? ` on ${formatDate(approvedAt)}` : ''}.
        </p>
      ) : null}
      {status === 'declined' ? (
        <div className="rounded-md border border-red-200 bg-red-50/60 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100">
          <p>
            <span className="font-semibold">Declined</span>
            {declinedAt ? ` on ${formatDate(declinedAt)}` : ''}
            {declinedReason ? ` — ${declinedReason}` : ''}
          </p>
        </div>
      ) : null}

      {approvalMethod && approvalMethod !== 'digital' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-4 dark:border-amber-800 dark:bg-amber-950/20">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200">Manual override</p>
          <p className="mt-1 text-sm">
            Recorded via{' '}
            <span className="font-medium">
              {manualApprovalMethodLabels[approvalMethod as ManualApprovalMethod] ?? approvalMethod}
            </span>
            .
          </p>
          {approvalNotes ? (
            <p className="mt-2 whitespace-pre-wrap text-sm">{approvalNotes}</p>
          ) : null}
          {approvalProofPaths.length > 0 ? (
            <div className="mt-3">
              <p className="mb-1 text-xs text-muted-foreground">Proof</p>
              <ul className="flex flex-wrap gap-2">
                {approvalProofPaths.map((p) => {
                  const url = approvalProofSignedUrls[p];
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

      <div className="flex flex-wrap items-center justify-end gap-2">
        {canCopyOrPreview ? (
          <>
            <Button size="sm" variant="outline" onClick={copyApprovalLink}>
              Copy link
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/projects/${projectId}/estimate/preview`}>
                <Pencil className="size-3.5" />
                Preview &amp; {status === 'pending_approval' ? 'resend' : 'share'}
              </Link>
            </Button>
          </>
        ) : null}
        {canMarkApproval ? (
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
        {canReset ? (
          <Button size="sm" variant="ghost" onClick={resetEstimate} disabled={isPending}>
            {status === 'pending_approval' ? 'Reset' : 'Reset to draft'}
          </Button>
        ) : null}
        {canCreateInvoice ? (
          <Button size="sm" onClick={createInvoice} disabled={isPending}>
            Create invoice from estimate
          </Button>
        ) : null}
      </div>

      <ManualApprovalDialog
        open={manualDialog.open}
        onOpenChange={(o) => setManualDialog((d) => ({ ...d, open: o }))}
        resourceType="estimate"
        resourceId={projectId}
        mode={manualDialog.mode}
        bypassedSend={status === 'draft'}
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
