'use client';

/**
 * Soft-delete confirmation for a job. Mirrors Track A's
 * `DeleteCustomerButton`: the server action redirects to `/jobs` on success,
 * so reaching the post-action branch implies an error that we surface via
 * toast.
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
import { deleteJobAction } from '@/server/actions/jobs';

export function DeleteJobButton({ jobId, customerName }: { jobId: string; customerName: string }) {
  const [pending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await deleteJobAction(jobId);
        if (result && 'ok' in result && !result.ok) {
          toast.error(result.error);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NEXT_REDIRECT')) {
          throw err;
        }
        toast.error('Failed to delete job. Please try again.');
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
          <AlertDialogTitle>Delete this job?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the job for {customerName} from the board. Related invoices and photos stay
            intact.
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
