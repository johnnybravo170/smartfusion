'use client';

/**
 * Small "Make recurring" control on the expense edit page. Opens a
 * dialog asking which day of the month to repeat on (1-28; we cap at
 * 28 so there's no "Feb 30 doesn't exist" edge case).
 *
 * Creates a rule cloning the current expense's vendor/amount/category/
 * tax. The daily cron takes it from there.
 */

import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createRecurringFromExpenseAction } from '@/server/actions/expense-recurring';

export function MakeRecurringButton({ expenseId }: { expenseId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState<number>(new Date().getDate() > 28 ? 1 : new Date().getDate());
  const [pending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await createRecurringFromExpenseAction({
        source_expense_id: expenseId,
        day_of_month: day,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Recurring monthly on the ${day}${ordinal(day)}`);
      setOpen(false);
      router.push('/expenses');
    });
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <RefreshCw className="size-3.5" />
        Make recurring
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Make this recurring</DialogTitle>
            <DialogDescription>
              Clones this expense every month on the day you pick. Cancel any time from the expenses
              page.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="rec-day">Day of month (1–28)</Label>
            <Input
              id="rec-day"
              type="number"
              min={1}
              max={28}
              value={day}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                setDay(Number.isFinite(n) ? Math.max(1, Math.min(28, n)) : 1);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Capped at 28 so short months work the same as long ones.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={pending}>
              {pending ? 'Saving…' : 'Start recurring'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return 'th';
  const last = n % 10;
  if (last === 1) return 'st';
  if (last === 2) return 'nd';
  if (last === 3) return 'rd';
  return 'th';
}
