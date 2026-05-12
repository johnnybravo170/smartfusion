'use client';

/**
 * QuickBooks import launcher — kicks off a backfill of historical
 * QBO data into HeyHenry. Phase 4a scope: customers only, with the
 * shape ready for future entities (vendors / items / invoices / etc.).
 *
 * Lives inside the connected-state QuickBooks card on /settings.
 *
 * The action runs synchronously today; UI polls `fetchImportJobAction`
 * for live progress while it's running.
 */

import { Loader2, PlayCircle, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  cancelQboImportAction,
  fetchImportJobAction,
  startQboImportAction,
} from '@/server/actions/qbo-import';

type EntityCounters = {
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
};

type JobSnapshot = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  entity_counters: Partial<Record<string, EntityCounters>>;
  api_calls_used: number;
  review_queue: Array<{ qbo_id: string; qbo_name: string }>;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
};

const POLL_INTERVAL_MS = 1500;

const ENTITY_ORDER = [
  'Customer',
  'Vendor',
  'Item',
  'Invoice',
  'Estimate',
  'Payment',
  'Bill',
  'Purchase',
] as const;

const ENTITY_LABEL: Record<(typeof ENTITY_ORDER)[number], string> = {
  Customer: 'Customers',
  Vendor: 'Vendors',
  Item: 'Items',
  Invoice: 'Invoices',
  Estimate: 'Estimates',
  Payment: 'Payments',
  Bill: 'Bills',
  Purchase: 'Expenses',
};

function emptyCounters(): EntityCounters {
  return { fetched: 0, imported: 0, skipped: 0, failed: 0 };
}

export function QuickBooksImportLauncher() {
  const [isPending, startTransition] = useTransition();
  const [isCancelling, startCancelTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function handleCancel() {
    if (!activeJobId) return;
    startCancelTransition(async () => {
      const result = await cancelQboImportAction(activeJobId);
      if (result.ok) {
        toast.success('Import cancelled.');
        // Refresh job snapshot so UI reflects the new state quickly;
        // the worker may still be mid-page when we set 'cancelled',
        // so the polling loop continues until the worker finishes.
        const refreshed = await fetchImportJobAction(activeJobId);
        if (refreshed.ok) setJob(refreshed.job as JobSnapshot);
      } else {
        toast.error(result.error);
      }
    });
  }

  const isRunning = job?.status === 'queued' || job?.status === 'running';

  // Poll job state while running. Stops on completion/failure.
  useEffect(() => {
    if (!activeJobId || !isRunning) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    const tick = async () => {
      const result = await fetchImportJobAction(activeJobId);
      if (result.ok) {
        setJob(result.job as JobSnapshot);
      }
    };
    tick();
    pollRef.current = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [activeJobId, isRunning]);

  const handleStart = useCallback(() => {
    startTransition(async () => {
      // Ordering matters for FK resolution:
      //   Customer + Vendor must precede Invoice/Estimate/Payment/Bill.
      //   Invoice must precede Payment (payment.invoice_id FK).
      //   Item is independent.
      //   Purchase is independent.
      const result = await startQboImportAction({
        entities: [
          'Customer',
          'Vendor',
          'Item',
          'Invoice',
          'Estimate',
          'Payment',
          'Bill',
          'Purchase',
        ],
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setActiveJobId(result.jobId);
      const final = await fetchImportJobAction(result.jobId);
      if (final.ok) {
        setJob(final.job as JobSnapshot);
        const counters =
          (final.job.entity_counters as Record<string, EntityCounters | undefined>) ?? {};
        const totalImported = ENTITY_ORDER.reduce(
          (acc, k) => acc + (counters[k]?.imported ?? 0),
          0,
        );
        const totalReview = (final.job.review_queue as unknown[] | undefined)?.length ?? 0;
        if (final.job.status === 'completed') {
          if (totalImported > 0) {
            toast.success(
              `Imported ${totalImported} record${totalImported === 1 ? '' : 's'}${
                totalReview > 0 ? ` · ${totalReview} need review` : ''
              }.`,
            );
          } else {
            toast.info('Nothing new to import.');
          }
        } else if (final.job.status === 'queued') {
          // Worker hit its time budget; cron will resume.
          toast.info(`Import continuing in the background (${totalImported} so far).`);
        } else if (final.job.status === 'failed') {
          toast.error(final.job.error_message ?? 'Import failed.');
        }
      }
    });
  }, []);

  const reviewCount = job?.review_queue?.length ?? 0;

  return (
    <div className="space-y-3">
      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!isRunning) setDialogOpen(open);
        }}
      >
        <DialogTrigger asChild>
          <Button size="sm" variant="default" disabled={isPending}>
            <PlayCircle className="size-3.5" />
            Import from QuickBooks
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import from QuickBooks</DialogTitle>
            <DialogDescription>
              We&rsquo;ll pull customers, pricebook items, and invoices from your QuickBooks
              company. Strong customer matches (same email or phone) auto-merge with your existing
              HH contacts; weaker matches go to a review queue. Item and invoice de-dup is keyed on
              the QBO id, so re-running is safe.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-sm">
            <Label className="font-medium">What gets imported</Label>
            <ul className="space-y-1 pl-4 text-muted-foreground">
              <li>• Customers + Vendors (name, email, phone, billing address)</li>
              <li>• Pricebook items (services, parts, T&amp;M placeholders)</li>
              <li>• Invoices + Estimates (header + line items, frozen money math)</li>
              <li>• Payments (linked to invoices)</li>
              <li>• Bills + Bill line items (read-only AP from QBO)</li>
              <li>• Purchases (one-off expenses)</li>
              <li className="text-xs">Re-running is safe — every record is keyed on its QBO id.</li>
            </ul>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setDialogOpen(false);
                handleStart();
              }}
              disabled={isPending}
            >
              {isPending && <Loader2 className="size-3.5 animate-spin" />}
              Start import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {job && (
        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">
              {job.status === 'running' ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3.5 animate-spin" />
                  Importing&hellip;
                </span>
              ) : job.status === 'queued' ? (
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Continuing in background&hellip;
                </span>
              ) : job.status === 'completed' ? (
                'Import complete'
              ) : job.status === 'failed' ? (
                <span className="text-destructive">Import failed</span>
              ) : (
                'Cancelled'
              )}
            </span>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">
                {job.api_calls_used} API call{job.api_calls_used === 1 ? '' : 's'}
              </span>
              {(job.status === 'running' || job.status === 'queued') && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={handleCancel}
                  disabled={isCancelling}
                >
                  {isCancelling ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <XCircle className="size-3.5" />
                  )}
                  Cancel
                </Button>
              )}
            </div>
          </div>
          <div className="mt-2 space-y-1 text-xs">
            {ENTITY_ORDER.map((key) => {
              const counts =
                (job.entity_counters?.[key] as EntityCounters | undefined) ?? emptyCounters();
              // Hide rows that never got fetched (e.g. user picked a
              // subset of entities someday, or QBO returned 0).
              if (counts.fetched === 0 && counts.imported === 0 && counts.failed === 0) {
                return null;
              }
              return <EntityRow key={key} label={ENTITY_LABEL[key]} counts={counts} />;
            })}
          </div>
          {reviewCount > 0 && job.status === 'completed' && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300">
              <span>
                {reviewCount} customer{reviewCount === 1 ? '' : 's'} need
                {reviewCount === 1 ? 's' : ''} your review.
              </span>
              <Link href="/settings/qbo-review" className="font-medium underline">
                Resolve now →
              </Link>
            </div>
          )}
          {(() => {
            const counters =
              (job.entity_counters as Record<string, EntityCounters | undefined>) ?? {};
            const fkSkipped =
              (counters.Invoice?.skipped ?? 0) +
              (counters.Estimate?.skipped ?? 0) +
              (counters.Payment?.skipped ?? 0) +
              (counters.Bill?.skipped ?? 0);
            if (fkSkipped === 0 || job.status !== 'completed') return null;
            return (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
                {fkSkipped} record{fkSkipped === 1 ? '' : 's'} skipped — a parent (customer or
                vendor) wasn&rsquo;t imported. Resolve the review queue, then re-run.
              </p>
            );
          })()}
          {job.error_message && (
            <p className="mt-2 break-words font-mono text-xs text-destructive">
              {job.error_message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function EntityRow({ label, counts }: { label: string; counts: EntityCounters }) {
  return (
    <div className="grid grid-cols-[1fr_repeat(4,minmax(0,50px))] items-baseline gap-2 rounded bg-background px-2 py-1.5 tabular-nums">
      <span className="font-medium">{label}</span>
      <span className="text-right text-muted-foreground" title="Fetched">
        {counts.fetched}
      </span>
      <span className="text-right" title="Imported">
        {counts.imported}
      </span>
      <span
        className={`text-right ${counts.skipped > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
        title="Skipped / needs review"
      >
        {counts.skipped}
      </span>
      <span
        className={`text-right ${counts.failed > 0 ? 'text-destructive' : 'text-muted-foreground'}`}
        title="Failed"
      >
        {counts.failed}
      </span>
    </div>
  );
}
