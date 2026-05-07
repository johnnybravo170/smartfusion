'use client';

import { Ban, CheckCircle, Copy, Loader2, Mail, Send } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import {
  resendInvoiceAction,
  sendInvoiceAction,
  voidInvoiceAction,
} from '@/server/actions/invoices';
import { RecordPaymentDialog } from './record-payment-dialog';

type Props = {
  invoiceId: string;
  status: InvoiceStatus;
  paymentUrl: string | null;
  customerEmail: string | null;
  /** Pre-saved alt emails on the customer record. Pre-checked in the
   *  send dialog; per-send opt-out works the same as on estimates. */
  customerAdditionalEmails?: string[];
  hasStripe?: boolean;
  /** Invoice grand total in cents — used to flag amount mismatches in OCR. */
  invoiceTotalCents?: number;
};

export function InvoiceActions({
  invoiceId,
  status,
  paymentUrl,
  customerEmail,
  customerAdditionalEmails = [],
  hasStripe = true,
  invoiceTotalCents,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Recipient checklist for the send / resend dialogs. Initialised
  // from customer.email + customer.additional_emails; operator can
  // opt any out for this send only, or add a one-off CC.
  const initialRecipients = [customerEmail, ...customerAdditionalEmails]
    .filter((e): e is string => Boolean(e?.trim()))
    .map((e) => e.trim().toLowerCase());
  const [recipientList, setRecipientList] = useState<{ email: string; checked: boolean }[]>(
    initialRecipients.map((email) => ({ email, checked: true })),
  );
  const [extraRecipient, setExtraRecipient] = useState('');

  function selectedRecipients(): string[] {
    const fromList = recipientList.filter((r) => r.checked).map((r) => r.email);
    const extra = extraRecipient.trim().toLowerCase();
    if (extra) fromList.push(extra);
    return Array.from(new Set(fromList));
  }

  function handleSend() {
    startTransition(async () => {
      const result = await sendInvoiceAction({
        invoiceId,
        recipientEmails: selectedRecipients(),
      });
      if (result.ok) {
        toast.success('Invoice sent!');
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

  function handleResend() {
    startTransition(async () => {
      const result = await resendInvoiceAction({
        invoiceId,
        recipientEmails: selectedRecipients(),
      });
      if (result.ok) {
        toast.success('Invoice resent.');
        if (result.warning) {
          toast.warning(result.warning);
        }
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
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={isPending} size="sm">
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send invoice
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Send invoice?</AlertDialogTitle>
              <AlertDialogDescription>
                Pick which addresses receive this email. The customer's saved emails are
                pre-checked; uncheck any you don't want on this send. Add a one-off CC if needed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <RecipientChecklist
              recipientList={recipientList}
              setRecipientList={setRecipientList}
              extraRecipient={extraRecipient}
              setExtraRecipient={setExtraRecipient}
              disabled={isPending}
            />
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleSend}
                disabled={isPending || selectedRecipients().length === 0}
              >
                Send
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
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
                <Mail className="size-3.5" />
              )}
              Resend
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Resend invoice?</AlertDialogTitle>
              <AlertDialogDescription>
                This sends another email with the invoice and payment link. Tweak the recipient list
                if you want a different mix this time.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <RecipientChecklist
              recipientList={recipientList}
              setRecipientList={setRecipientList}
              extraRecipient={extraRecipient}
              setExtraRecipient={setExtraRecipient}
              disabled={isPending}
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={handleResend}
                disabled={isPending || selectedRecipients().length === 0}
              >
                Send
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <RecordPaymentDialog
          invoiceId={invoiceId}
          invoiceTotalCents={invoiceTotalCents}
          hasStripe={hasStripe}
          trigger={
            <Button variant="outline" size="sm" disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle className="size-3.5" />
              )}
              Record payment
            </Button>
          }
        />
        <VoidButton onVoid={handleVoid} isPending={isPending} />
      </div>
    );
  }

  // paid or void: no actions
  return null;
}

/**
 * Pre-checked checklist of saved recipient emails plus a "Also CC"
 * one-off field. Mirrored on the estimate send bar — same shape so
 * operators see the same UX on both surfaces.
 */
function RecipientChecklist({
  recipientList,
  setRecipientList,
  extraRecipient,
  setExtraRecipient,
  disabled,
}: {
  recipientList: { email: string; checked: boolean }[];
  setRecipientList: (
    updater: (prev: { email: string; checked: boolean }[]) => { email: string; checked: boolean }[],
  ) => void;
  extraRecipient: string;
  setExtraRecipient: (v: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Recipients</Label>
      {recipientList.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No saved emails on this customer — type one below.
        </p>
      ) : (
        <div className="space-y-1">
          {recipientList.map((row, idx) => (
            <label
              key={row.email}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted/50"
            >
              <input
                type="checkbox"
                checked={row.checked}
                onChange={(e) =>
                  setRecipientList((prev) => {
                    const next = [...prev];
                    next[idx] = { ...next[idx], checked: e.target.checked };
                    return next;
                  })
                }
                disabled={disabled}
              />
              <span className="text-sm">{row.email}</span>
            </label>
          ))}
        </div>
      )}
      <Input
        type="email"
        placeholder="Also CC (this send only)…"
        value={extraRecipient}
        onChange={(e) => setExtraRecipient(e.target.value)}
        disabled={disabled}
      />
    </div>
  );
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
