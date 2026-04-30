'use client';

/**
 * Diff review modal — opens when the operator taps the unsent-changes
 * chip (or any URL with `?review=diff`). Lists every change in the
 * working state vs the latest signed snapshot, with Henry's suggested
 * categorization (rule-based) and a per-row revert action.
 *
 * v1 scope: revert per change. Bundled "Send N selected as a CO" is
 * a follow-up — for now operators send via the existing Changes tab.
 *
 * See decision 6790ef2b — diff-tracked + intentional-send.
 */

import { ArrowRight, ListChecks, Loader2, RotateCcw } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { DiffChange, ProjectScopeDiff } from '@/lib/db/queries/project-scope-diff';
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import { revertChangeAction } from '@/server/actions/project-scope-diff';

export function ScopeDiffReviewClient({
  projectId,
  initialDiff,
}: {
  projectId: string;
  initialDiff: ProjectScopeDiff;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const open = searchParams.get('review') === 'diff';

  function close() {
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete('review');
    const next = sp.toString();
    router.replace(next ? `?${next}` : '?', { scroll: false });
  }

  // Local copy of the diff so we can hide rows optimistically as they
  // get reverted. Re-syncs from server on close (revalidatePath).
  const [diff, setDiff] = useState(initialDiff);
  useEffect(() => {
    setDiff(initialDiff);
  }, [initialDiff]);

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : close())}>
      <DialogContent className="max-w-3xl lg:max-w-5xl xl:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Unsent changes since v{diff.baseline_version ?? 1}</DialogTitle>
          <DialogDescription>
            These edits are in your working state but haven&rsquo;t been sent to the customer.
            Revert anything you don&rsquo;t want, then send the rest as a change order from the
            Changes tab when you&rsquo;re ready.
          </DialogDescription>
        </DialogHeader>

        <div className="my-2 flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-xs">
          <div className="flex items-center gap-3">
            <div>
              <span className="font-semibold">Total impact:</span>{' '}
              <span
                className={cn(
                  'tabular-nums',
                  diff.total_delta_cents > 0 && 'text-amber-700',
                  diff.total_delta_cents < 0 && 'text-emerald-700',
                )}
              >
                {diff.total_delta_cents > 0 ? '+' : ''}
                {formatCurrency(diff.total_delta_cents)}
              </span>
            </div>
            <div className="text-muted-foreground">
              v{diff.baseline_version ?? 1}: {formatCurrency(diff.baseline_total_cents)} → working:{' '}
              {formatCurrency(diff.current_total_cents)}
            </div>
          </div>
          {diff.suggested_co_count > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {diff.suggested_co_count} likely customer-impacting
            </span>
          ) : null}
        </div>

        {diff.changes.length === 0 ? (
          <EmptyState onClose={close} />
        ) : (
          <ul className="max-h-[55vh] divide-y overflow-y-auto rounded-md border">
            {diff.changes.map((c) => (
              <ChangeRow key={`${c.kind}-${changeTargetId(c)}`} change={c} projectId={projectId} />
            ))}
          </ul>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Ready to send these to the customer? Open the Changes tab to create a Change Order.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={close}>
              Close
            </Button>
            <Button
              size="sm"
              onClick={() => {
                router.push(`/projects/${projectId}/change-orders/new`);
              }}
            >
              Create Change Order
              <ArrowRight className="size-3.5" />
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function changeTargetId(c: DiffChange): string {
  switch (c.kind) {
    case 'line_added':
    case 'line_removed':
      return c.line.id;
    case 'line_modified':
      return c.after.id;
    case 'category_added':
      return c.category.id;
    case 'category_envelope_changed':
      return c.after.id;
  }
}

function ChangeRow({ change, projectId }: { change: DiffChange; projectId: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function revert() {
    startTransition(async () => {
      const res = await revertChangeAction({
        projectId,
        changeKind: change.kind,
        targetId: changeTargetId(change),
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Reverted to last signed value.');
      router.refresh();
    });
  }

  const henryHint =
    'henry_suggests' in change && change.henry_suggests === 'send_as_co'
      ? { label: 'Likely customer-impacting', tone: 'co' as const }
      : { label: 'Looks internal', tone: 'internal' as const };

  return (
    <li className={cn('flex items-start gap-3 px-3 py-2.5', pending && 'opacity-60')}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {kindLabel(change.kind)}
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              henryHint.tone === 'co'
                ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {henryHint.label}
          </span>
        </div>
        <div className="mt-1 text-sm">{describeChange(change)}</div>
      </div>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        onClick={revert}
        disabled={pending}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <RotateCcw className="size-3.5" />
        )}
        Revert
      </Button>
    </li>
  );
}

function kindLabel(kind: DiffChange['kind']): string {
  switch (kind) {
    case 'line_added':
      return 'Line added';
    case 'line_removed':
      return 'Line removed';
    case 'line_modified':
      return 'Line edited';
    case 'category_added':
      return 'Bucket added';
    case 'category_envelope_changed':
      return 'Envelope edited';
  }
}

function describeChange(c: DiffChange): React.ReactNode {
  switch (c.kind) {
    case 'line_added':
      return (
        <>
          <span className="font-medium">{c.line.label}</span>
          <span className="text-muted-foreground">
            {' '}
            · {c.line.qty} {c.line.unit} × {formatCurrency(c.line.unit_price_cents)}{' '}
            <span className="text-emerald-700">+{formatCurrency(c.line.line_price_cents)}</span>
          </span>
        </>
      );
    case 'line_removed':
      return (
        <>
          <span className="font-medium line-through">{c.line.label}</span>
          <span className="text-muted-foreground">
            {' '}
            · was {formatCurrency(c.line.line_price_cents)}{' '}
            <span className="text-rose-700">−{formatCurrency(c.line.line_price_cents)}</span>
          </span>
        </>
      );
    case 'line_modified': {
      const before = c.before.line_price_cents;
      const after = c.after.line_price_cents;
      const delta = after - before;
      const labelChanged = c.before.label !== c.after.label;
      return (
        <>
          <span className="font-medium">
            {labelChanged ? (
              <>
                <span className="line-through text-muted-foreground">{c.before.label}</span> →{' '}
                {c.after.label}
              </>
            ) : (
              c.after.label
            )}
          </span>
          <span className="text-muted-foreground">
            {' '}
            · {formatCurrency(before)} → {formatCurrency(after)}{' '}
            <span className={delta >= 0 ? 'text-amber-700' : 'text-emerald-700'}>
              ({delta >= 0 ? '+' : ''}
              {formatCurrency(delta)})
            </span>
          </span>
        </>
      );
    }
    case 'category_added':
      return (
        <>
          <span className="font-medium">{c.category.name}</span>
          <span className="text-muted-foreground"> · new bucket in {c.category.section}</span>
        </>
      );
    case 'category_envelope_changed': {
      const delta = c.after.estimate_cents - c.before.estimate_cents;
      return (
        <>
          <span className="font-medium">{c.after.name}</span>
          <span className="text-muted-foreground">
            {' '}
            envelope · {formatCurrency(c.before.estimate_cents)} →{' '}
            {formatCurrency(c.after.estimate_cents)}{' '}
            <span className={delta >= 0 ? 'text-amber-700' : 'text-emerald-700'}>
              ({delta >= 0 ? '+' : ''}
              {formatCurrency(delta)})
            </span>
          </span>
        </>
      );
    }
  }
}

function EmptyState({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <ListChecks className="size-7 text-muted-foreground" />
      <p className="text-sm font-medium">No unsent changes</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Working state matches the last signed version. Edit the budget to make changes.
      </p>
      <Button size="sm" variant="ghost" onClick={onClose} className="mt-1">
        Close
      </Button>
    </div>
  );
}
