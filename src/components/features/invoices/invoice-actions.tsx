'use client';

import { Ban, CheckCircle, Copy, Loader2, Send } from 'lucide-react';
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import {
  markInvoicePaidAction,
  sendInvoiceAction,
  voidInvoiceAction,
} from '@/server/actions/invoices';

type Props = {
  invoiceId: string;
  status: InvoiceStatus;
  paymentUrl: string | null;
};

export function InvoiceActions({ invoiceId, status, paymentUrl }: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function handleSend() {
    startTransition(async () => {
      const result = await sendInvoiceAction({ invoiceId });
      if (result.ok) {
        toast.success('Invoice sent! Payment link created.');
        if (result.warning) {
          toast.warning(result.warning);
        }
        if (result.paymentUrl) {
          await navigator.clipboard.writeText(result.paymentUrl).catch(() => {});
          toast.info('Payment link copied to clipboard.');
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleVoid() {
    startTransition(async () => {
      const result = await voidInvoiceAction({ invoiceId });
      if (result.ok) {
        toast.success('Invoice voided.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleMarkPaid() {
    startTransition(async () => {
      const result = await markInvoicePaidAction({ invoiceId });
      if (result.ok) {
        toast.success('Invoice marked as paid.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function handleCopyLink() {
    if (!paymentUrl) return;
    navigator.clipboard.writeText(paymentUrl).then(
      () => toast.success('Payment link copied!'),
      () => toast.error('Failed to copy link.'),
    );
  }

  if (status === 'draft') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={handleSend} disabled={isPending} size="sm">
          {isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          Send invoice
        </Button>
        <VoidButton onVoid={handleVoid} isPending={isPending} />
      </div>
    );
  }

  if (status === 'sent') {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {paymentUrl && (
          <Button variant="outline" size="sm" onClick={handleCopyLink}>
            <Copy className="size-3.5" />
            Copy payment link
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle className="size-3.5" />
              )}
              Mark as paid
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Mark invoice as paid?</AlertDialogTitle>
              <AlertDialogDescription>
                Use this for cash, e-transfer, or other off-Stripe payments. This cannot be undone.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleMarkPaid} disabled={isPending}>
                Confirm paid
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <VoidButton onVoid={handleVoid} isPending={isPending} />
      </div>
    );
  }

  // paid or void: no actions
  return null;
}

function VoidButton({ onVoid, isPending }: { onVoid: () => void; isPending: boolean }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-destructive" disabled={isPending}>
          <Ban className="size-3.5" />
          Void
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this invoice?</AlertDialogTitle>
          <AlertDialogDescription>
            The invoice will be marked as void and cannot be un-voided. If the customer has a
            payment link, it will no longer work.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onVoid} disabled={isPending}>
            Void invoice
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
