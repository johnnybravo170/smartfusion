'use client';

import {
  AlertTriangle,
  Ban,
  CheckCircle,
  Copy,
  Loader2,
  Mail,
  Paperclip,
  Send,
  Sparkles,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import {
  extractPaymentReceiptAction,
  markInvoicePaidAction,
  resendInvoiceAction,
  sendInvoiceAction,
  uploadInvoiceReceiptAction,
  voidInvoiceAction,
} from '@/server/actions/invoices';

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'e-transfer', label: 'E-transfer' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'other', label: 'Other' },
] as const;

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

type StagedReceipt = {
  id: string;
  file: File;
  previewUrl: string;
};

const REFERENCE_LABELS: Record<string, string> = {
  cash: 'Reference (optional)',
  cheque: 'Cheque #',
  'e-transfer': 'Confirmation #',
  stripe: 'Reference (optional)',
  other: 'Reference (optional)',
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
  const [paymentMethod, setPaymentMethod] = useState('e-transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [staged, setStaged] = useState<StagedReceipt[]>([]);
  const [paidDialogOpen, setPaidDialogOpen] = useState(false);
  const [ocrPending, setOcrPending] = useState(false);
  const [ocrAmountCents, setOcrAmountCents] = useState<number | null>(null);
  const [ocrApplied, setOcrApplied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function handleAddReceipts(files: FileList | null) {
    if (!files || files.length === 0) return;
    const incoming: StagedReceipt[] = [];
    for (const file of Array.from(files)) {
      if (staged.length + incoming.length >= 10) {
        toast.error('Up to 10 receipts per payment.');
        break;
      }
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`${file.name} is over 10 MB.`);
        continue;
      }
      incoming.push({
        id: crypto.randomUUID(),
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }
    setStaged((prev) => [...prev, ...incoming]);

    // Fire OCR on the first image only if we don't already have a result —
    // multiple receipt photos for one payment are usually different views of
    // the same cheque. GC can re-fire by removing all and re-adding.
    if (!ocrApplied && !ocrPending && incoming.length > 0) {
      const first = incoming[0];
      runOcr(first.file);
    }
  }

  function runOcr(file: File) {
    setOcrPending(true);
    void (async () => {
      try {
        const fd = new FormData();
        fd.append('file', file);
        fd.append('payment_method', paymentMethod);
        const result = await extractPaymentReceiptAction(fd);
        if (!result.ok) {
          // Silent — OCR failure is not fatal, GC fills manually.
          return;
        }
        const { amount_cents, reference, paid_on, payer_name, notes } = result.data;
        const filledParts: string[] = [];

        // Soft-fill: only populate fields the user hasn't typed into.
        if (reference) {
          setPaymentReference((prev) => {
            if (prev.trim()) return prev;
            filledParts.push('reference');
            return reference;
          });
        }

        const noteFragments: string[] = [];
        if (payer_name) noteFragments.push(`From ${payer_name}`);
        if (paid_on) noteFragments.push(`Dated ${paid_on}`);
        if (notes) noteFragments.push(notes);
        if (noteFragments.length > 0) {
          setPaymentNotes((prev) => {
            if (prev.trim()) return prev;
            filledParts.push('notes');
            return noteFragments.join(' · ');
          });
        }

        if (typeof amount_cents === 'number') {
          setOcrAmountCents(amount_cents);
        }

        if (filledParts.length > 0) {
          setOcrApplied(true);
          toast.info(`Filled ${filledParts.join(' + ')} from receipt photo.`);
        }
      } finally {
        setOcrPending(false);
      }
    })();
  }

  function removeStaged(id: string) {
    setStaged((prev) => {
      const target = prev.find((s) => s.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((s) => s.id !== id);
    });
  }

  function resetPaidForm() {
    for (const s of staged) URL.revokeObjectURL(s.previewUrl);
    setStaged([]);
    setPaymentReference('');
    setPaymentNotes('');
    setOcrAmountCents(null);
    setOcrApplied(false);
    setOcrPending(false);
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

  function handleMarkPaid() {
    startTransition(async () => {
      // Upload any staged receipts first; collect their storage paths.
      const receiptPaths: string[] = [];
      for (const item of staged) {
        const fd = new FormData();
        fd.append('file', item.file);
        fd.append('invoice_id', invoiceId);
        const upload = await uploadInvoiceReceiptAction(fd);
        if (!upload.ok) {
          toast.error(`${item.file.name}: ${upload.error}`);
          return;
        }
        receiptPaths.push(upload.path);
      }

      const result = await markInvoicePaidAction({
        invoiceId,
        paymentMethod,
        paymentReference,
        paymentNotes,
        receiptPaths,
      });
      if (result.ok) {
        toast.success(`Invoice marked as paid via ${paymentMethod}.`);
        resetPaidForm();
        setPaidDialogOpen(false);
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
        <Dialog
          open={paidDialogOpen}
          onOpenChange={(open) => {
            setPaidDialogOpen(open);
            if (!open) resetPaidForm();
          }}
        >
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" disabled={isPending}>
              {isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCircle className="size-3.5" />
              )}
              Record payment
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Record payment</DialogTitle>
              <DialogDescription>
                Mark this invoice paid. Once recorded, this cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4 py-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payment-method">Payment method</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger id="payment-method" className="w-full">
                    <SelectValue placeholder="Payment method" />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.filter((m) => hasStripe || m.value !== 'stripe').map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payment-reference">
                  {REFERENCE_LABELS[paymentMethod] ?? 'Reference (optional)'}
                </Label>
                <Input
                  id="payment-reference"
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  placeholder={
                    paymentMethod === 'cheque'
                      ? 'e.g. 1042'
                      : paymentMethod === 'e-transfer'
                        ? 'e.g. CA8X9P'
                        : 'Optional'
                  }
                  maxLength={200}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="payment-notes">Notes (optional)</Label>
                <Textarea
                  id="payment-notes"
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                  placeholder="e.g. Cheque deposited Friday"
                  rows={2}
                  maxLength={2000}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label>Receipt photos (optional)</Label>
                  {ocrPending ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Reading receipt…
                    </span>
                  ) : ocrApplied ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Sparkles className="size-3" />
                      Filled from photo
                    </span>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-start gap-2">
                  {staged.map((s) => (
                    <div
                      key={s.id}
                      className="relative size-16 overflow-hidden rounded-md border bg-muted"
                    >
                      {/* biome-ignore lint/performance/noImgElement: blob-URL preview */}
                      <img
                        src={s.previewUrl}
                        alt="Receipt preview"
                        className="size-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removeStaged(s.id)}
                        className="absolute -right-1 -top-1 inline-flex size-5 items-center justify-center rounded-full border bg-background shadow-sm hover:bg-muted"
                        aria-label="Remove receipt"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex size-16 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-xs text-muted-foreground hover:border-primary hover:bg-primary/5 hover:text-foreground"
                  >
                    <Paperclip className="size-4" />
                    Attach
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      handleAddReceipts(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Snap a photo of the cheque or signed receipt. Up to 10, max 10 MB each. Henry
                  reads the photo and prefills the fields above.
                </p>
                {ocrAmountCents != null &&
                invoiceTotalCents != null &&
                Math.abs(ocrAmountCents - invoiceTotalCents) > 1 ? (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      Photo shows ${(ocrAmountCents / 100).toFixed(2)} but invoice total is $
                      {(invoiceTotalCents / 100).toFixed(2)}. Partial payment, wrong photo, or bad
                      read?
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="outline" disabled={isPending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button onClick={handleMarkPaid} disabled={isPending}>
                {isPending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Confirm paid
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
