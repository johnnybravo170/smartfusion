'use client';

import { Trash2 } from 'lucide-react';
import { useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { WorkerExpense } from '@/lib/db/queries/worker-expenses';
import { formatCurrency } from '@/lib/pricing/calculator';
import { deleteWorkerExpenseAction } from '@/server/actions/worker-expenses';

type Row = WorkerExpense & { receiptUrl: string | null };

type Props = { entries: Row[] };

function canDelete(createdAt: string): boolean {
  return Date.now() - new Date(createdAt).getTime() < 24 * 60 * 60 * 1000;
}

export function WorkerExpenseList({ entries }: Props) {
  const tz = useTenantTimezone();
  const [pending, startTransition] = useTransition();

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No expenses logged yet. Tap &ldquo;Log expense&rdquo; to add your first one.
      </p>
    );
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteWorkerExpenseAction(id);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Expense deleted.');
    });
  }

  const total = entries.reduce((s, r) => s + r.amount_cents, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {entries.length} {entries.length === 1 ? 'expense' : 'expenses'}
        </span>
        <span>{formatCurrency(total)} total</span>
      </div>
      <div className="divide-y rounded-lg border">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-start gap-3 p-3">
            {entry.receiptUrl ? (
              // biome-ignore lint/performance/noImgElement: dynamic receipt URL
              <img
                src={entry.receiptUrl}
                alt="Receipt"
                className="h-12 w-12 shrink-0 rounded border object-cover"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{formatCurrency(entry.amount_cents)}</span>
                <span className="text-muted-foreground">
                  {new Intl.DateTimeFormat('en-CA', {
                    timeZone: tz,
                    weekday: 'short',
                    month: 'short',
                    day: 'numeric',
                  }).format(new Date(`${entry.expense_date}T00:00`))}
                </span>
              </div>
              <p className="text-sm">
                {entry.project_name ?? 'Unknown project'}
                {entry.vendor ? (
                  <span className="text-muted-foreground"> · {entry.vendor}</span>
                ) : null}
              </p>
              {entry.description ? (
                <p className="text-xs text-muted-foreground">{entry.description}</p>
              ) : null}
            </div>
            {canDelete(entry.created_at) ? (
              <Button
                variant="ghost"
                size="icon"
                disabled={pending}
                onClick={() => handleDelete(entry.id)}
                aria-label="Delete expense"
              >
                <Trash2 className="size-4" />
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
