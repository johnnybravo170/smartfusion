'use client';

/**
 * Vendor quotes section on the project Costs tab. Lists existing quotes
 * grouped by status, with accept/reject/delete affordances and the
 * create-new form.
 *
 * Accept button requires the allocation invariant (sum === total); the
 * server action re-checks and returns an error if they drift. If no
 * buckets exist on the project yet, the "New vendor quote" button shows
 * a gentle "create a bucket first" hint rather than erroring later.
 */

import { CheckCircle2, ChevronDown, ChevronRight, FileStack, Pencil, XCircle } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { SubQuoteRow } from '@/lib/db/queries/project-sub-quotes';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  acceptSubQuoteAction,
  deleteSubQuoteAction,
  rejectSubQuoteAction,
} from '@/server/actions/sub-quotes';
import { SubQuoteForm } from './sub-quote-form';
import { SubQuoteUploadButton } from './sub-quote-upload-button';

type Bucket = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

const STATUS_LABEL: Record<SubQuoteRow['status'], string> = {
  pending_review: 'Pending review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  expired: 'Expired',
  superseded: 'Superseded',
};

const STATUS_CLASS: Record<SubQuoteRow['status'], string> = {
  pending_review: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200',
  accepted: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200',
  rejected: 'bg-muted text-muted-foreground',
  expired: 'bg-muted text-muted-foreground',
  superseded: 'bg-muted text-muted-foreground line-through',
};

export function SubQuotesSection({
  projectId,
  subQuotes,
  buckets,
}: {
  projectId: string;
  subQuotes: SubQuoteRow[];
  buckets: Bucket[];
}) {
  const [showForm, setShowForm] = useState(false);

  const acceptedTotal = subQuotes
    .filter((q) => q.status === 'accepted')
    .reduce((s, q) => s + q.total_cents, 0);
  const pendingTotal = subQuotes
    .filter((q) => q.status === 'pending_review')
    .reduce((s, q) => s + q.total_cents, 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Vendor quotes</h3>
          <p className="text-xs text-muted-foreground">
            {formatCurrency(acceptedTotal)} committed
            {pendingTotal > 0 ? ` · ${formatCurrency(pendingTotal)} pending` : ''}
          </p>
        </div>
        {!showForm && (
          <div className="flex gap-2">
            <SubQuoteUploadButton projectId={projectId} buckets={buckets} />
            <Button
              size="sm"
              onClick={() => setShowForm(true)}
              disabled={buckets.length === 0}
              title={buckets.length === 0 ? 'Create at least one cost bucket first.' : undefined}
            >
              + New vendor quote
            </Button>
          </div>
        )}
      </div>

      {showForm ? (
        <div className="mb-4">
          <SubQuoteForm projectId={projectId} buckets={buckets} onDone={() => setShowForm(false)} />
        </div>
      ) : null}

      {subQuotes.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed bg-muted/20 px-6 py-10 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-muted">
            <FileStack className="size-6 text-muted-foreground" />
          </div>
          <div className="max-w-md space-y-1">
            <p className="font-medium">No vendor quotes yet.</p>
            <p className="text-sm text-muted-foreground">
              Vendor quotes are quotes you&apos;ve received from trades or suppliers for parts of
              this project. Logging them gives you a live view of what you&apos;ve committed so your
              cost control stays accurate.
            </p>
          </div>
          {buckets.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Create at least one cost bucket above, then come back here.
            </p>
          ) : (
            <div className="flex flex-wrap justify-center gap-2 pt-1">
              <SubQuoteUploadButton projectId={projectId} buckets={buckets} />
              <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
                + Add manually
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {subQuotes.map((q) => (
            <SubQuoteRowView key={q.id} quote={q} projectId={projectId} buckets={buckets} />
          ))}
        </div>
      )}
    </section>
  );
}

function SubQuoteRowView({
  quote,
  projectId,
  buckets,
}: {
  quote: SubQuoteRow;
  projectId: string;
  buckets: Bucket[];
}) {
  const [expanded, setExpanded] = useState(quote.status === 'pending_review');
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();

  const allocatedSum = quote.allocations.reduce((s, a) => s + a.allocated_cents, 0);
  const balanced = allocatedSum === quote.total_cents && quote.total_cents > 0;

  function handleAccept() {
    if (!balanced) {
      toast.error('Allocations must equal the quote total before accepting.');
      return;
    }
    startTransition(async () => {
      const result = await acceptSubQuoteAction({
        subQuoteId: quote.id,
        projectId,
        replaceExisting: 'auto',
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Vendor quote accepted.');
    });
  }

  function handleReject() {
    if (!confirm('Reject this vendor quote?')) return;
    startTransition(async () => {
      const result = await rejectSubQuoteAction({ subQuoteId: quote.id, projectId });
      if (!result.ok) toast.error(result.error);
    });
  }

  function handleDelete() {
    if (!confirm('Delete this vendor quote permanently?')) return;
    startTransition(async () => {
      const result = await deleteSubQuoteAction({ subQuoteId: quote.id, projectId });
      if (!result.ok) toast.error(result.error);
    });
  }

  return (
    <div className="rounded-md border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-muted/40"
      >
        {expanded ? (
          <ChevronDown className="size-4 flex-shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-4 flex-shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{quote.vendor_name}</span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                STATUS_CLASS[quote.status],
              )}
            >
              {STATUS_LABEL[quote.status]}
            </span>
          </div>
          {quote.scope_description ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {quote.scope_description}
            </p>
          ) : null}
        </div>
        <div className="text-right">
          <p className="font-semibold tabular-nums">{formatCurrency(quote.total_cents)}</p>
          {quote.quote_date ? (
            <p className="text-[11px] text-muted-foreground">{quote.quote_date}</p>
          ) : null}
        </div>
      </button>

      {expanded && editing ? (
        <div className="border-t px-3 py-3">
          <SubQuoteForm
            projectId={projectId}
            buckets={buckets}
            editingQuoteId={quote.id}
            initialValues={{
              vendor_name: quote.vendor_name,
              vendor_email: quote.vendor_email ?? '',
              vendor_phone: quote.vendor_phone ?? '',
              total_cents: quote.total_cents,
              scope_description: quote.scope_description ?? '',
              notes: quote.notes ?? '',
              quote_date: quote.quote_date ?? '',
              valid_until: quote.valid_until ?? '',
              allocations: quote.allocations.map((a) => ({
                budget_category_id: a.budget_category_id,
                allocated_cents: a.allocated_cents,
                notes: a.notes ?? undefined,
              })),
            }}
            onDone={() => setEditing(false)}
          />
        </div>
      ) : null}

      {expanded && !editing ? (
        <div className="border-t px-3 py-3 text-sm">
          {/* Allocations */}
          {quote.allocations.length === 0 ? (
            <p className="text-xs italic text-muted-foreground">
              No allocations yet. Edit to assign this quote to buckets.
            </p>
          ) : (
            <div className="space-y-1">
              {quote.allocations.map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between rounded bg-muted/30 px-2 py-1 text-xs"
                >
                  <span>{a.budget_category_name ?? '(deleted bucket)'}</span>
                  <span className="tabular-nums">{formatCurrency(a.allocated_cents)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between pt-1 text-xs font-medium">
                <span>Allocated</span>
                <span
                  className={cn(
                    'tabular-nums',
                    balanced
                      ? 'text-emerald-700 dark:text-emerald-300'
                      : 'text-amber-700 dark:text-amber-300',
                  )}
                >
                  {formatCurrency(allocatedSum)} / {formatCurrency(quote.total_cents)}
                </span>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-3 flex flex-wrap gap-2">
            {quote.status === 'pending_review' ? (
              <>
                <Button
                  size="xs"
                  onClick={handleAccept}
                  disabled={pending || !balanced}
                  title={balanced ? undefined : 'Balance allocations first.'}
                >
                  <CheckCircle2 className="mr-1 size-3" />
                  Accept
                </Button>
                <Button size="xs" variant="ghost" onClick={handleReject} disabled={pending}>
                  <XCircle className="mr-1 size-3" />
                  Reject
                </Button>
              </>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)} disabled={pending}>
              <Pencil className="mr-1 size-3" />
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleDelete}
              disabled={pending}
              className="text-destructive hover:text-destructive"
            >
              Delete
            </Button>
          </div>

          {quote.notes ? (
            <p className="mt-2 text-xs text-muted-foreground">
              <span className="font-medium">Notes:</span> {quote.notes}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
