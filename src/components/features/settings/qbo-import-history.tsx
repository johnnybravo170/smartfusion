'use client';

/**
 * QBO import history + rollback.
 *
 * Lists the last 20 imports for the tenant. Each row shows entity
 * counters, API-call usage, and a Roll back button when the batches
 * are still active. Rollback is destructive — guarded behind an
 * AlertDialog with an explicit confirm.
 */

import { History, Loader2, Undo2 } from 'lucide-react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ImportHistoryEntry,
  rollbackImportJobAction,
} from '@/server/actions/qbo-import-rollback';

type Props = {
  jobs: ImportHistoryEntry[];
};

const ENTITY_LABEL: Record<string, string> = {
  Customer: 'customers',
  Vendor: 'vendors',
  Item: 'items',
  Invoice: 'invoices',
  Estimate: 'estimates',
  Payment: 'payments',
  Bill: 'bills',
  Purchase: 'expenses',
};

function importedSummary(entityCounters: ImportHistoryEntry['entity_counters']): string {
  const parts: string[] = [];
  for (const [entity, counters] of Object.entries(entityCounters)) {
    if (!counters || counters.imported === 0) continue;
    const label = ENTITY_LABEL[entity] ?? entity.toLowerCase();
    parts.push(`${counters.imported} ${label}`);
  }
  return parts.length === 0 ? 'nothing imported' : parts.join(' · ');
}

export function QboImportHistory({ jobs }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [activeJob, setActiveJob] = useState<string | null>(null);

  function rollback(jobId: string) {
    setActiveJob(jobId);
    startTransition(async () => {
      const result = await rollbackImportJobAction({ jobId });
      if (result.ok) {
        const total = Object.values(result.deleted).reduce((a, b) => a + b, 0);
        toast.success(
          total === 0
            ? 'Nothing left to roll back.'
            : `Rolled back ${total} record${total === 1 ? '' : 's'}.`,
        );
        router.refresh();
      } else {
        toast.error(result.error);
      }
      setActiveJob(null);
    });
  }

  if (jobs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <History className="size-5" />
            No imports yet
          </CardTitle>
          <CardDescription>
            Run an import from <span className="font-mono">/settings</span> → QuickBooks card to
            populate history.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {jobs.map((job) => {
        const isPending = pending && activeJob === job.id;
        const canRollback = job.active_batch_count > 0;
        return (
          <Card key={job.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                    {new Date(job.created_at).toLocaleString()}
                    <Badge
                      variant={
                        job.status === 'completed'
                          ? 'secondary'
                          : job.status === 'failed'
                            ? 'destructive'
                            : 'outline'
                      }
                      className="font-normal"
                    >
                      {job.status}
                    </Badge>
                    {job.rolled_back && (
                      <Badge variant="outline" className="font-normal text-muted-foreground">
                        rolled back
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription>
                    {importedSummary(job.entity_counters)} · {job.api_calls_used} API call
                    {job.api_calls_used === 1 ? '' : 's'}
                  </CardDescription>
                </div>
                {canRollback && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="outline" size="sm" disabled={isPending}>
                        {isPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Undo2 className="size-3.5" />
                        )}
                        Roll back
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Roll back this import?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Every record this import inserted will be deleted: customers, vendors,
                          items, invoices, estimates, payments, bills, and expenses tagged with this
                          job&rsquo;s import batches. Customers you manually edited will be gone too
                          if they came from this import. There is no automatic re-import.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => rollback(job.id)}
                          disabled={isPending}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          {isPending && <Loader2 className="size-3.5 animate-spin" />}
                          Yes, roll back
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {Object.entries(job.entity_counters)
                  .filter(([, counters]) => counters && counters.fetched > 0)
                  .map(([entity, counters]) => (
                    <div key={entity} className="rounded bg-muted/30 p-2">
                      <dt className="font-medium">{ENTITY_LABEL[entity] ?? entity}</dt>
                      <dd className="text-muted-foreground">
                        {counters.imported} imported
                        {counters.skipped > 0 ? ` · ${counters.skipped} skipped` : ''}
                        {counters.failed > 0 ? ` · ${counters.failed} failed` : ''}
                      </dd>
                    </div>
                  ))}
              </dl>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
