'use client';

/**
 * Action buttons for the quote detail page. Each button handles one lifecycle
 * transition (send, accept, reject, delete, convert to job).
 */

import { Briefcase, Check, Download, Loader2, Mail, Send, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { AutoFollowupRow } from '@/components/features/shared/auto-followup-row';
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
  convertQuoteToProjectAction,
  deleteQuoteAction,
  rejectQuoteAction,
  sendQuoteAction,
} from '@/server/actions/quotes';

export function SendQuoteButton({
  quoteId,
  autoFollowupTenantDefault,
  autoFollowupAvailable,
}: {
  quoteId: string;
  /** Tenant default for quote-follow-up (Settings → Automations). */
  autoFollowupTenantDefault: boolean;
  /** Whether the tenant's plan unlocks the follow-up feature. */
  autoFollowupAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [autoFollowup, setAutoFollowup] = useState(
    autoFollowupAvailable ? autoFollowupTenantDefault : false,
  );

  function handleSend() {
    startTransition(async () => {
      const result = await sendQuoteAction({ quoteId, autoFollowupOverride: autoFollowup });
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
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" disabled={pending}>
          {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Send quote to customer?</AlertDialogTitle>
          <AlertDialogDescription>
            This will email the quote PDF to the customer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AutoFollowupRow
          checked={autoFollowup}
          onCheckedChange={setAutoFollowup}
          disabled={pending || !autoFollowupAvailable}
          available={autoFollowupAvailable}
          id={`send-${quoteId}-followup`}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleSend} disabled={pending}>
            Send
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ResendQuoteButton({
  quoteId,
  customerEmail,
  autoFollowupTenantDefault,
  autoFollowupAvailable,
}: {
  quoteId: string;
  customerEmail: string | null;
  autoFollowupTenantDefault: boolean;
  autoFollowupAvailable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [autoFollowup, setAutoFollowup] = useState(
    autoFollowupAvailable ? autoFollowupTenantDefault : false,
  );

  function handleResend() {
    startTransition(async () => {
      const result = await sendQuoteAction({ quoteId, autoFollowupOverride: autoFollowup });
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
        <AutoFollowupRow
          checked={autoFollowup}
          onCheckedChange={setAutoFollowup}
          disabled={pending || !autoFollowupAvailable}
          available={autoFollowupAvailable}
          id={`resend-${quoteId}-followup`}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
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

export function ConvertToProjectButton({ quoteId }: { quoteId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function handleConvert() {
    startTransition(async () => {
      const result = await convertQuoteToProjectAction({ quoteId });
      if (result.ok) {
        toast.success('Project created from quote.');
        router.push(`/projects/${result.id}`);
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Button onClick={handleConvert} disabled={pending} size="sm" variant="outline">
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Briefcase className="size-3.5" />}
      Convert to project
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
