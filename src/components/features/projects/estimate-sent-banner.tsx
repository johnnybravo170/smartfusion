/**
 * Persistent post-send banner on the Budget page. Visible once the
 * estimate has been sent to the customer for approval and stays until
 * the customer signs (or declines). Provides a quiet, always-on
 * confirmation that the operator's send action actually happened — the
 * "send for approval" gravity carries through to the project state.
 *
 * Hidden when the estimate hasn't been sent or has already been
 * approved/declined (those have their own surfaces).
 */

import { Clock, ExternalLink } from 'lucide-react';
import Link from 'next/link';

type Props = {
  estimateStatus: 'draft' | 'pending_approval' | 'approved' | 'declined' | string;
  sentAt: string | null;
  customerName: string | null;
  approvalCode: string | null;
};

export function EstimateSentBanner({ estimateStatus, sentAt, customerName, approvalCode }: Props) {
  if (estimateStatus !== 'pending_approval' || !sentAt) return null;

  const date = new Date(sentAt);
  const dateText = date.toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const timeText = date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <div className="flex items-center gap-2">
        <Clock className="size-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Sent to {customerName ?? 'the customer'}</span> on{' '}
          {dateText} at {timeText} · awaiting signature
        </span>
      </div>
      {approvalCode ? (
        <Link
          href={`/approve/${approvalCode}`}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide hover:underline"
        >
          View what they see
          <ExternalLink className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}
