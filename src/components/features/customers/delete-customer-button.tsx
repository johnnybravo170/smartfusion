'use client';

/**
 * Delete-customer confirmation. Soft-deletes the row via the server action
 * so quote/job/invoice history isn't orphaned (see PHASE_1_PLAN §13.9).
 * The action redirects to `/customers` on success; an uncaught rejection
 * means something went wrong — we show a toast in that case.
 */

import { Trash2 } from 'lucide-react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { deleteCustomerAction } from '@/server/actions/customers';

export function DeleteCustomerButton({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const [pending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    // We want the dialog to keep control; stop the default close and run
    // the action in a transition. The server action redirects on success.
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await deleteCustomerAction(customerId);
        // A successful delete redirects and never returns, so reaching this
        // branch means the server returned an error.
        if (result && 'ok' in result && !result.ok) {
          toast.error(result.error);
        }
      } catch (err) {
        // `NEXT_REDIRECT` is the success path — re-throw so the runtime can
        // complete the redirect. Anything else is a real failure.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NEXT_REDIRECT')) {
          throw err;
        }
        toast.error('Failed to delete customer. Please try again.');
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {customerName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This hides the customer from your lists. Their quote, job, and invoice history stays
            intact for your records.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending ? 'Deleting…' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
