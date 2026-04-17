'use client';

/**
 * Action buttons for the quote detail page. Each button handles one lifecycle
 * transition (send, accept, reject, delete, convert to job).
 */

import { Briefcase, Check, Download, Loader2, Mail, Send, Trash2, X } from 'lucide-react';
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
import {
  acceptQuoteAction,
  convertQuoteToJobAction,
  deleteQuoteAction,
  rejectQuoteAction,
  sendQuoteAction,
} from '@/server/actions/quotes';

export function SendQuoteButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleSend() {
    startTransition(async () => {
      const result = await sendQuoteAction({ quoteId });
      if (result.ok) {
        toast.success('Quote sent.');
        if (result.warning) {
          toast.warning(result.warning);
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button onClick={handleSend} disabled={pending} size="sm">
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
      Send
    </Button>
  );
}

export function ResendQuoteButton({
  quoteId,
  customerEmail,
}: {
  quoteId: string;
  customerEmail: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleResend() {
    startTransition(async () => {
      const result = await sendQuoteAction({ quoteId });
      if (result.ok) {
        toast.success('Quote resent.');
        if (result.warning) {
          toast.warning(result.warning);
        }
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
          Resend
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Resend to {customerEmail ?? 'customer (no email on file)'}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This will send another email with the quote to the customer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleResend} disabled={pending}>
            Send
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AcceptQuoteButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleAccept() {
    startTransition(async () => {
      const result = await acceptQuoteAction({ quoteId });
      if (result.ok) {
        toast.success('Quote accepted.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button onClick={handleAccept} disabled={pending} size="sm" variant="outline">
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
      Mark accepted
    </Button>
  );
}

export function RejectQuoteButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleReject() {
    startTransition(async () => {
      const result = await rejectQuoteAction({ quoteId });
      if (result.ok) {
        toast.success('Quote rejected.');
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button
      onClick={handleReject}
      disabled={pending}
      size="sm"
      variant="ghost"
      className="text-destructive"
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
      Mark rejected
    </Button>
  );
}

export function ConvertToJobButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleConvert() {
    startTransition(async () => {
      const result = await convertQuoteToJobAction({ quoteId });
      if (result.ok) {
        toast.success('Job created from quote.');
        router.push(`/jobs/${result.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button onClick={handleConvert} disabled={pending} size="sm">
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Briefcase className="size-3.5" />}
      Convert to job
    </Button>
  );
}

export function DownloadPdfButton({ pdfUrl }: { pdfUrl: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
        <Download className="size-3.5" />
        Download PDF
      </a>
    </Button>
  );
}

export function DeleteQuoteButton({
  quoteId,
  customerName,
}: {
  quoteId: string;
  customerName: string;
}) {
  const [pending, startTransition] = useTransition();

  function handleConfirm(event: React.MouseEvent) {
    event.preventDefault();
    startTransition(async () => {
      try {
        const result = await deleteQuoteAction(quoteId);
        if (result && 'ok' in result && !result.ok) {
          toast.error(result.error);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('NEXT_REDIRECT')) {
          throw err;
        }
        toast.error('Failed to delete quote. Please try again.');
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
          <AlertDialogTitle>Delete this quote?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the quote for {customerName}. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={pending}
            className="bg-destructive/10 text-destructive hover:bg-destructive/20"
          >
            {pending ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
