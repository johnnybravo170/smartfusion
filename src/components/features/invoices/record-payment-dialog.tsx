'use client';

import { AlertTriangle, CheckCircle, Loader2, Paperclip, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import {
  extractPaymentReceiptAction,
  markInvoicePaidAction,
  uploadInvoiceReceiptAction,
} from '@/server/actions/invoices';

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'cheque', label: 'Cheque' },
  { value: 'e-transfer', label: 'E-transfer' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'other', label: 'Other' },
] as const;

const REFERENCE_LABELS: Record<string, string> = {
  cash: 'Reference (optional)',
  cheque: 'Cheque #',
  'e-transfer': 'Confirmation #',
  stripe: 'Reference (optional)',
  other: 'Reference (optional)',
};

type StagedReceipt = {
  id: string;
  file: File;
  previewUrl: string;
};

type Props = {
  invoiceId: string;
  /** Invoice grand total in cents — used to flag amount mismatches in OCR. */
  invoiceTotalCents?: number;
  hasStripe?: boolean;
  /** Element placed inside `DialogTrigger`. Required — caller picks the button styling. */
  trigger: ReactNode;
};

export function RecordPaymentDialog({
  invoiceId,
  invoiceTotalCents,
  hasStripe = true,
  trigger,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('e-transfer');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [staged, setStaged] = useState<StagedReceipt[]>([]);
  const [ocrPending, setOcrPending] = useState(false);
  const [ocrAmountCents, setOcrAmountCents] = useState<number | null>(null);
  const [ocrApplied, setOcrApplied] = useState(false);
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

  function resetForm() {
    for (const s of staged) URL.revokeObjectURL(s.previewUrl);
    setStaged([]);
    setPaymentReference('');
    setPaymentNotes('');
    setOcrAmountCents(null);
    setOcrApplied(false);
    setOcrPending(false);
  }

  function handleMarkPaid() {
    startTransition(async () => {
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
        resetForm();
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetForm();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
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
              Snap a photo of the cheque or signed receipt. Up to 10, max 10 MB each. Henry reads
              the photo and prefills the fields above.
            </p>
            {ocrAmountCents != null &&
            invoiceTotalCents != null &&
            Math.abs(ocrAmountCents - invoiceTotalCents) > 1 ? (
              <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Photo shows ${(ocrAmountCents / 100).toFixed(2)} but invoice total is $
                  {(invoiceTotalCents / 100).toFixed(2)}. Partial payment, wrong photo, or bad read?
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
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <CheckCircle className="size-3.5" />
            )}
            Confirm paid
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
