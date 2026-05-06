'use client';

/**
 * /settings/imports — list of every import batch with a rollback button.
 *
 * Phase A handles `customers` batches only. Other kinds (projects,
 * invoices, expenses) render in the list but their rollback button is
 * disabled with a tooltip until their phase ships and adds the
 * corresponding rollback action.
 */

import { History, Loader2, Sparkles, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { rollbackCustomerImportAction } from '@/server/actions/onboarding-import';
import { rollbackProjectImportAction } from '@/server/actions/onboarding-import-projects';

export type ImportBatchRow = {
  id: string;
  kind: 'customers' | 'projects' | 'invoices' | 'expenses';
  sourceFilename: string | null;
  /** customersCreated only set for kind='projects' (side-effect customers
   *  created when project rows referenced new customer names). */
  summary: {
    created?: number;
    merged?: number;
    skipped?: number;
    customersCreated?: number;
  };
  note: string | null;
  createdAt: string;
  createdByEmail: string | null;
  rolledBackAt: string | null;
  rolledBackByEmail: string | null;
};

export function ImportsList({
  batches,
  timezone,
}: {
  batches: ImportBatchRow[];
  timezone: string;
}) {
  if (batches.length === 0) {
    return <EmptyState />;
  }
  return (
    <div className="flex flex-col gap-3">
      {batches.map((b) => (
        <BatchRow key={b.id} batch={b} timezone={timezone} />
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border bg-card p-10 text-center">
      <History className="size-6 text-muted-foreground" />
      <p className="text-sm font-medium">Nothing imported yet</p>
      <p className="text-xs text-muted-foreground">
        When Henry brings in a batch of customers (or later, projects / invoices), it lands here so
        you can roll it back if you ever need to.
      </p>
      <Button asChild className="mt-2">
        <Link href="/contacts/import">
          <Sparkles className="size-3.5" />
          Import customers
        </Link>
      </Button>
    </div>
  );
}

function BatchRow({ batch, timezone }: { batch: ImportBatchRow; timezone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const rollbackable = batch.kind === 'customers' || batch.kind === 'projects';
  const rolledBack = !!batch.rolledBackAt;
  const created = batch.summary.created ?? 0;
  const merged = batch.summary.merged ?? 0;
  const skipped = batch.summary.skipped ?? 0;
  const sideEffectCustomers = batch.summary.customersCreated ?? 0;

  function handleRollback() {
    if (!rollbackable) return;
    startTransition(async () => {
      if (batch.kind === 'customers') {
        const res = await rollbackCustomerImportAction(batch.id);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success(
          `Rolled back. ${res.deleted} customer${res.deleted === 1 ? '' : 's'} removed.`,
        );
      } else if (batch.kind === 'projects') {
        const res = await rollbackProjectImportAction(batch.id);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const parts = [`${res.deletedProjects} project${res.deletedProjects === 1 ? '' : 's'}`];
        if (res.deletedCustomers > 0) {
          parts.push(
            `${res.deletedCustomers} side-effect customer${res.deletedCustomers === 1 ? '' : 's'}`,
          );
        }
        toast.success(`Rolled back. ${parts.join(' + ')} removed.`);
      }
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border bg-card p-4 ${
        rolledBack ? 'opacity-60' : ''
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-medium capitalize">{batch.kind}</span>
            <Badge variant="outline" className="text-xs">
              {created} new
            </Badge>
            {merged > 0 ? (
              <Badge variant="outline" className="text-xs">
                {merged} merged
              </Badge>
            ) : null}
            {skipped > 0 ? (
              <Badge variant="outline" className="text-xs">
                {skipped} skipped
              </Badge>
            ) : null}
            {sideEffectCustomers > 0 && batch.kind === 'projects' ? (
              <Badge variant="outline" className="text-xs">
                + {sideEffectCustomers} new customer
                {sideEffectCustomers === 1 ? '' : 's'}
              </Badge>
            ) : null}
            {rolledBack ? (
              <Badge variant="secondary" className="bg-amber-100 text-amber-900 text-xs">
                Rolled back
              </Badge>
            ) : null}
          </div>
          {batch.note ? <p className="text-sm text-foreground">{batch.note}</p> : null}
          <p className="text-xs text-muted-foreground">
            {batch.sourceFilename ? <>{batch.sourceFilename} · </> : null}
            {formatTimestamp(batch.createdAt, timezone)}
            {batch.createdByEmail ? <> by {batch.createdByEmail}</> : null}
          </p>
          {rolledBack ? (
            <p className="text-xs text-amber-700">
              Rolled back {formatTimestamp(batch.rolledBackAt!, timezone)}
              {batch.rolledBackByEmail ? <> by {batch.rolledBackByEmail}</> : null}
            </p>
          ) : null}
        </div>

        {!rolledBack ? (
          <AlertDialog open={open} onOpenChange={setOpen}>
            <Button
              variant="outline"
              size="sm"
              disabled={!rollbackable || pending}
              title={
                rollbackable
                  ? batch.kind === 'projects'
                    ? 'Soft-delete every project (and any side-effect customers) from this batch.'
                    : 'Soft-delete every customer that came from this batch.'
                  : `Rollback for ${batch.kind} batches will land in a later phase.`
              }
              onClick={() => setOpen(true)}
            >
              <Undo2 className="size-3.5" />
              Roll back
            </Button>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Roll this batch back?</AlertDialogTitle>
                <AlertDialogDescription asChild>
                  <div className="space-y-2 text-sm">
                    {batch.kind === 'projects' ? (
                      <p>
                        We'll soft-delete the {created} {created === 1 ? 'project' : 'projects'}{' '}
                        Henry created in this batch
                        {sideEffectCustomers > 0 ? (
                          <>
                            , plus the {sideEffectCustomers}{' '}
                            {sideEffectCustomers === 1 ? 'customer' : 'customers'} created alongside
                            them
                          </>
                        ) : null}
                        . Existing projects/customers (anything marked merged) stay put.
                      </p>
                    ) : (
                      <p>
                        We'll soft-delete the {created} {created === 1 ? 'customer' : 'customers'}{' '}
                        that Henry created in this batch. Your existing customers (the ones marked
                        as merged) stay put.
                      </p>
                    )}
                    <p className="text-muted-foreground">
                      Soft-delete means they're hidden but recoverable — get in touch if you need to
                      undo a rollback.
                    </p>
                  </div>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={handleRollback} disabled={pending}>
                  {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Roll back
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </div>
    </div>
  );
}

function formatTimestamp(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso));
}
