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

import { Loader2, PlayCircle } from 'lucide-react';
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
import { fetchImportJobAction, startQboImportAction } from '@/server/actions/qbo-import';

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

function emptyCounters(): EntityCounters {
  return { fetched: 0, imported: 0, skipped: 0, failed: 0 };
}

export function QuickBooksImportLauncher() {
  const [isPending, startTransition] = useTransition();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobSnapshot | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const result = await startQboImportAction({ entities: ['Customer'] });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      setActiveJobId(result.jobId);
      // The action ran synchronously to completion; pull final state.
      const final = await fetchImportJobAction(result.jobId);
      if (final.ok) {
        setJob(final.job as JobSnapshot);
        const customer =
          (final.job.entity_counters as Record<string, EntityCounters | undefined>)?.Customer ??
          emptyCounters();
        if (final.job.status === 'completed') {
          if (customer.imported > 0) {
            toast.success(
              `Imported ${customer.imported} customer${customer.imported === 1 ? '' : 's'}${
                customer.skipped > 0 ? ` · ${customer.skipped} need review` : ''
              }.`,
            );
          } else {
            toast.info('No new customers to import.');
          }
        } else if (final.job.status === 'failed') {
          toast.error(final.job.error_message ?? 'Import failed.');
        }
      }
    });
  }, []);

  const customerCounts =
    (job?.entity_counters?.Customer as EntityCounters | undefined) ?? emptyCounters();
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
              Phase 1: customers. We&rsquo;ll pull every customer from your QuickBooks company and
              match them against contacts you already have in HeyHenry. Strong matches (same email
              or phone) auto-merge; weaker matches go to a review queue for you to confirm.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-sm">
            <Label className="font-medium">What gets imported in this pass</Label>
            <ul className="space-y-1 pl-4 text-muted-foreground">
              <li>• Customers (name, email, phone, billing address)</li>
              <li className="text-xs">
                Vendors, items, invoices, payments, estimates, bills, and expenses land in follow-up
                releases.
              </li>
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
              {job.status === 'running' || job.status === 'queued' ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="size-3.5 animate-spin" />
                  Importing&hellip;
                </span>
              ) : job.status === 'completed' ? (
                'Import complete'
              ) : job.status === 'failed' ? (
                <span className="text-destructive">Import failed</span>
              ) : (
                'Cancelled'
              )}
            </span>
            <span className="text-xs text-muted-foreground">
              {job.api_calls_used} API call{job.api_calls_used === 1 ? '' : 's'}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
            <div className="flex flex-col rounded bg-background p-2">
              <dt className="text-muted-foreground">Fetched</dt>
              <dd className="font-mono">{customerCounts.fetched}</dd>
            </div>
            <div className="flex flex-col rounded bg-background p-2">
              <dt className="text-muted-foreground">Imported</dt>
              <dd className="font-mono">{customerCounts.imported}</dd>
            </div>
            <div className="flex flex-col rounded bg-background p-2">
              <dt className="text-muted-foreground">To review</dt>
              <dd className="font-mono">{customerCounts.skipped}</dd>
            </div>
            <div className="flex flex-col rounded bg-background p-2">
              <dt className="text-muted-foreground">Failed</dt>
              <dd className="font-mono">{customerCounts.failed}</dd>
            </div>
          </dl>
          {reviewCount > 0 && job.status === 'completed' && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              {reviewCount} customer{reviewCount === 1 ? '' : 's'} need
              {reviewCount === 1 ? 's' : ''} your review — resolution UI lands in the next release.
            </p>
          )}
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
