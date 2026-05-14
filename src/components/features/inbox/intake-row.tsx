/**
 * One row in the universal /inbox/intake list. Compact — the per-draft
 * detail view (Phase D) is where heavy review happens (chip row, full
 * artifact previews, AI extraction, accept/edit/etc).
 *
 * Action menu is state-aware and rendered by the parent via the
 * `actions` prop (so this row stays presentational and the menu can
 * grow in Phase D without touching the row markup).
 */

import { AlertCircle, FileText, Image as ImageIcon } from 'lucide-react';
import Link from 'next/link';
import type { InboxIntakeRow } from '@/lib/db/queries/intake-drafts';
import { IntakeSourceChip } from './intake-source-chip';

const KIND_LABEL: Record<string, string> = {
  voice_memo: 'Voice memo',
  damage_photo: 'Damage photo',
  reference_photo: 'Reference photo',
  sketch: 'Sketch',
  screenshot: 'Screenshot',
  sub_quote_pdf: 'Sub-trade quote',
  spec_drawing_pdf: 'Spec / drawing',
  receipt: 'Receipt',
  inspiration_photo: 'Inspiration',
  customer_message: 'Customer message',
  text_body: 'Email body',
  other: 'Artifact',
};

const DISPOSITION_TONE: Record<string, string> = {
  pending_review: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200',
  applied: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200',
  dismissed: 'bg-muted text-muted-foreground line-through',
  error: 'bg-destructive/10 text-destructive',
};

const DISPOSITION_LABEL: Record<string, string> = {
  pending_review: 'Needs review',
  applied: 'Applied',
  dismissed: 'Dismissed',
  error: 'Error',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('en-CA', {
    timeZone: 'America/Vancouver',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function summarize(row: InboxIntakeRow): string {
  if (row.email_subject) return row.email_subject;
  if (row.customer_name) return `Lead: ${row.customer_name}`;
  if (row.primary_kind) return KIND_LABEL[row.primary_kind] ?? 'Intake';
  return 'Intake item';
}

export function IntakeRow({
  row,
  actions,
}: {
  row: InboxIntakeRow;
  /** Optional actions slot rendered to the right of the row content. */
  actions?: React.ReactNode;
}) {
  const summary = summarize(row);
  const subline = row.source === 'email' ? row.email_from : row.customer_name || null;

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-start gap-3">
        {/* Thumbnail or kind icon */}
        <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted/30">
          {row.thumbnail_url ? (
            // biome-ignore lint/performance/noImgElement: signed URL not in next/image domains
            <img src={row.thumbnail_url} alt="" className="size-12 object-cover" loading="lazy" />
          ) : row.primary_kind === 'sub_quote_pdf' ||
            row.primary_kind === 'spec_drawing_pdf' ||
            row.primary_kind === 'receipt' ? (
            <FileText className="size-5 text-muted-foreground" />
          ) : (
            <ImageIcon className="size-5 text-muted-foreground" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <IntakeSourceChip source={row.source} />
            {row.primary_kind && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {KIND_LABEL[row.primary_kind] ?? row.primary_kind}
              </span>
            )}
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${DISPOSITION_TONE[row.disposition] ?? 'bg-muted'}`}
            >
              {DISPOSITION_LABEL[row.disposition] ?? row.disposition}
            </span>
            {row.disposition === 'error' && (
              <span className="inline-flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="size-3" />
                classifier error
              </span>
            )}
            {row.artifact_count > 1 && (
              <span className="text-xs text-muted-foreground">+{row.artifact_count - 1} more</span>
            )}
          </div>
          <p className="mt-1 truncate font-medium">{summary}</p>
          <p className="truncate text-xs text-muted-foreground">
            {subline ?? '—'}
            <span className="mx-1.5">·</span>
            {formatTime(row.created_at)}
          </p>
        </div>

        {actions}

        <Link
          href={`/inbox/intake/${row.id}`}
          className="shrink-0 text-xs text-muted-foreground underline hover:text-foreground"
        >
          Open
        </Link>
      </div>
    </div>
  );
}
