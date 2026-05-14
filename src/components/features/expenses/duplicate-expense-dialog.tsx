'use client';

/**
 * Shared dialog for "this expense looks like a duplicate" responses from
 * the overhead-expense actions. Used in both the full overhead form and
 * the top-bar quick-log button so both paths show the same confirm-or-
 * override UX. See PATTERNS.md §13.
 */

import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { formatCurrency } from '@/lib/pricing/calculator';

export type DuplicateExpense = {
  existing_id: string;
  vendor: string;
  amount_cents: number;
  expense_date: string;
};

type Props = {
  duplicate: DuplicateExpense | null;
  /** Called when the user dismisses the dialog without saving. */
  onClose: () => void;
  /** Called when the user clicks "Save anyway" — caller re-submits with `force=1`. */
  onForceSave: () => void;
  /** Disables both action buttons while a save is in flight. */
  busy?: boolean;
};

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

export function DuplicateExpenseDialog({ duplicate, onClose, onForceSave, busy }: Props) {
  const tz = useTenantTimezone();
  const router = useRouter();

  return (
    <Dialog open={!!duplicate} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Possible duplicate</DialogTitle>
          <DialogDescription>
            {duplicate ? (
              <>
                You already logged{' '}
                <span className="font-medium text-foreground">
                  {formatCurrency(duplicate.amount_cents)}
                </span>{' '}
                at <span className="font-medium text-foreground">{duplicate.vendor}</span> on{' '}
                <span className="font-medium text-foreground">
                  {formatDate(duplicate.expense_date, tz)}
                </span>
                . Log this one anyway?
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {duplicate ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(`/expenses/${duplicate.existing_id}/edit`)}
            >
              View existing
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={onForceSave} disabled={busy}>
            Save anyway
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
