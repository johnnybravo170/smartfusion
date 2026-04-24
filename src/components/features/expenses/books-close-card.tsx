'use client';

/**
 * Books-close control. Owner/admin/bookkeeper can set a "locked through"
 * date — expenses / bills / invoices dated on or before that get locked
 * from edits until the date is cleared.
 *
 * Pairs with the bookkeeper flow: after they file a quarter's GST
 * return, they close the books through the end of that quarter so the
 * operator can't accidentally backdate something into it.
 */

import { Lock, Unlock } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { setBooksClosedThroughAction } from '@/server/actions/books-close';

type Props = {
  currentClosedThrough: string | null;
};

export function BooksCloseCard({ currentClosedThrough }: Props) {
  const [value, setValue] = useState(currentClosedThrough ?? '');
  const [pending, startTransition] = useTransition();

  function save(through: string | null) {
    startTransition(async () => {
      const res = await setBooksClosedThroughAction({ through });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(through ? `Books closed through ${through}` : 'Books unlocked');
      if (!through) setValue('');
    });
  }

  const isLocked = !!currentClosedThrough;

  return (
    <div
      className={`rounded-md border p-4 ${
        isLocked
          ? 'border-amber-300 bg-amber-50/40 dark:border-amber-700 dark:bg-amber-950/20'
          : 'bg-muted/10'
      }`}
    >
      <div className="flex items-center gap-2">
        {isLocked ? (
          <Lock className="size-4" />
        ) : (
          <Unlock className="size-4 text-muted-foreground" />
        )}
        <p className="text-sm font-medium">
          {isLocked ? `Books locked through ${currentClosedThrough}` : 'Books are open'}
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {isLocked
          ? 'Expenses, bills, and invoices dated on or before this are locked from edits. Unlock to make changes to that period.'
          : 'Set a date to prevent retroactive edits to filed periods.'}
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="bc-through" className="text-xs">
            Locked through
          </Label>
          <Input
            id="bc-through"
            type="date"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-44 text-sm"
          />
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => save(value || null)}
          disabled={pending || !value}
        >
          {isLocked ? 'Update close date' : 'Close books'}
        </Button>
        {isLocked ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => save(null)}
            disabled={pending}
          >
            Unlock
          </Button>
        ) : null}
      </div>
    </div>
  );
}
