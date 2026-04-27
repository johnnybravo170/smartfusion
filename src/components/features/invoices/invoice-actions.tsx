'use client';

import { Ban, CheckCircle, Copy, Loader2, Mail, Paperclip, Send, X } from 'lucide-react';
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
  hasStripe?: boolean;
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
  hasStripe = true,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [paymentMethod, setPaymentMethod] = useState('e-transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [staged, setStaged] = useState<StagedReceipt[]>([]);
  const [paidDialogOpen, setPaidDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
  }

  function handleSend() {
    startTransition(async () => {
      const result = await sendInvoiceAction({ invoiceId });
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
      const result = await resendInvoiceAction({ invoiceId });
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
                <Mail className="size-3.5" />
              )}
              Resend
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Resend to {customerEmail ?? 'customer (no email on file)'}?
              </AlertDialogTitle>
              <AlertDialogDescription>
                This will send another email with the invoice and payment link to the customer.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleResend} disabled={isPending}>
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
                <Label>Receipt photos (optional)</Label>
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
                  Snap a photo of the cheque or signed receipt. Up to 10, max 10 MB each.
                </p>
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
