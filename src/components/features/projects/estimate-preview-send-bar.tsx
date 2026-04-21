'use client';

/**
 * Top-of-page send/back controls on the authed estimate preview. Wraps the
 * real send action in a confirmation dialog so the operator sees exactly
 * who the email is going to before it fires.
 */

import { ArrowLeft, Loader2, Send } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { sendEstimateForApprovalAction } from '@/server/actions/estimate-approval';

type Props = {
  projectId: string;
  customerName: string;
  customerEmail: string | null;
  totalFormatted: string;
  lineCount: number;
  alreadySent: boolean;
};

export function EstimatePreviewSendBar({
  projectId,
  customerName,
  customerEmail,
  totalFormatted,
  lineCount,
  alreadySent,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const canSend = !!customerEmail && lineCount > 0;

  function handleSend(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      const res = await sendEstimateForApprovalAction({ projectId });
      if (res.ok) {
        toast.success('Estimate sent to customer');
        setOpen(false);
        router.push(`/projects/${projectId}?tab=estimate`);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <div className="sticky top-0 z-10 -mx-4 mb-6 flex items-center justify-between gap-3 border-b bg-background/90 px-4 py-3 backdrop-blur">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => router.push(`/projects/${projectId}?tab=estimate`)}
      >
        <ArrowLeft className="size-3.5" />
        Back to estimate
      </Button>

      <div className="flex items-center gap-3">
        {!canSend ? (
          <span className="text-xs text-amber-700">
            {!customerEmail ? 'Customer has no email on file.' : 'Add cost lines first.'}
          </span>
        ) : null}
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger asChild>
            <Button disabled={!canSend}>
              <Send className="size-3.5" />
              {alreadySent ? 'Resend to customer' : 'Send to customer'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {alreadySent ? 'Resend estimate?' : 'Send estimate?'}
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm">
                  <p>
                    The estimate above will be emailed to{' '}
                    <span className="font-medium text-foreground">{customerName}</span> at{' '}
                    <span className="font-medium text-foreground">{customerEmail}</span>.
                  </p>
                  <p>
                    Total <span className="font-medium text-foreground">{totalFormatted}</span>{' '}
                    across {lineCount} line {lineCount === 1 ? 'item' : 'items'}.
                  </p>
                  {alreadySent ? (
                    <p className="text-amber-700">
                      This estimate has already been sent. Resending will keep the same approval
                      link but email the customer again.
                    </p>
                  ) : null}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleSend} disabled={pending}>
                {pending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Send className="size-3.5" />
                )}
                Send now
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  );
}
