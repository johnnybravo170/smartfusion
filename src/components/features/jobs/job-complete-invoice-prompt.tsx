'use client';

/**
 * Pop-up shown immediately after a job is marked complete. Pre-fills the
 * invoice amount from the linked quote and lets the operator generate the
 * invoice in one tap. Closes the revenue-leak gap of "I'll do invoices
 * later" and then forgetting.
 *
 * The actual creation goes through `createInvoiceAction` which already
 * validates job-status=complete + linked-quote-with-total. After success
 * we navigate to the invoice detail page so the operator can review and
 * hit Send (or schedule it).
 *
 * Pairs with both surfaces that complete a job:
 *   - JobStatusSelect (detail page + e2e)
 *   - JobBoard drag-drop
 */

import { Loader2, Receipt, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
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
import { formatCurrency } from '@/lib/pricing/calculator';
import { createInvoiceAction } from '@/server/actions/invoices';

type Props = {
  jobId: string;
  customerName: string;
  /** Pre-tax expected total (from linked quote). */
  quoteTotalCents: number | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function JobCompleteInvoicePrompt({
  jobId,
  customerName,
  quoteTotalCents,
  open,
  onOpenChange,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const totalLine =
    quoteTotalCents !== null && quoteTotalCents > 0
      ? `${formatCurrency(quoteTotalCents)} + tax`
      : null;

  function handleCreate() {
    startTransition(async () => {
      const res = await createInvoiceAction({ jobId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Invoice draft created.');
      onOpenChange(false);
      if (res.id) {
        router.push(`/invoices/${res.id}`);
      } else {
        router.push('/invoices');
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Receipt className="size-5 text-emerald-700" aria-hidden />
            Job done — invoice {customerName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {totalLine ? (
              <>
                Generating a draft invoice for{' '}
                <span className="font-medium text-foreground">{totalLine}</span>, pre-filled from
                the linked quote. You'll review and send on the next screen.
              </>
            ) : (
              <>
                Generating a draft invoice from the linked quote. You'll review the amount and send
                on the next screen.
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Not yet</AlertDialogCancel>
          <AlertDialogAction onClick={handleCreate} disabled={pending}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Create invoice
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
