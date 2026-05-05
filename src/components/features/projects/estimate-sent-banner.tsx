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

import { Clock, ExternalLink, Eye } from 'lucide-react';
import Link from 'next/link';

type Props = {
  estimateStatus: 'draft' | 'pending_approval' | 'approved' | 'declined' | string;
  sentAt: string | null;
  customerName: string | null;
  approvalCode: string | null;
  /** IANA tz of the contractor — server renders default to UTC otherwise. */
  timezone: string;
  /** Customer view tracking on the public /estimate/[code] page. */
  viewStats?: { total: number; last_viewed_at: string | null };
};

export function EstimateSentBanner({
  estimateStatus,
  sentAt,
  customerName,
  approvalCode,
  timezone,
  viewStats,
}: Props) {
  if (estimateStatus !== 'pending_approval' || !sentAt) return null;

  const date = new Date(sentAt);
  const dateText = new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timezone,
  }).format(date);
  const timeText = new Intl.DateTimeFormat('en-CA', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(date);
  const lastViewedText = viewStats?.last_viewed_at
    ? new Intl.DateTimeFormat('en-CA', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone,
      }).format(new Date(viewStats.last_viewed_at))
    : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50/60 px-3 py-2 text-xs text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Clock className="size-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Sent to {customerName ?? 'the customer'}</span> on{' '}
          {dateText} at {timeText} · awaiting signature
        </span>
        {viewStats && viewStats.total > 0 ? (
          <span className="inline-flex items-center gap-1 text-blue-800/80 dark:text-blue-200/80">
            <Eye className="size-3" />
            Viewed {viewStats.total}×{lastViewedText ? <span> · last {lastViewedText}</span> : null}
          </span>
        ) : null}
      </div>
      {approvalCode ? (
        <Link
          href={`/estimate/${approvalCode}`}
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
