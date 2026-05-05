'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type InvoiceDocFields,
  SUGGESTED_INVOICE_DEFAULTS,
} from '@/lib/invoices/default-doc-fields';
import { updateInvoiceDefaultsAction } from '@/server/actions/settings';

type FieldKey = keyof InvoiceDocFields;

const FIELD_META: Record<
  FieldKey,
  { label: string; description: string; placeholder: string; rows: number }
> = {
  payment_instructions: {
    label: 'Payment instructions',
    description: 'How customers pay you (e-transfer, cheque, mailing address).',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.payment_instructions,
    rows: 5,
  },
  terms: {
    label: 'Payment terms',
    description: 'When payment is due (e.g. "Due within 30 days").',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.terms,
    rows: 3,
  },
  policies: {
    label: 'Policies',
    description: 'Late fees, NSF cheques, warranty terms.',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.policies,
    rows: 3,
  },
};

function isMissing(v: string | null | undefined): boolean {
  return v == null || v.trim().length === 0;
}

export function InvoiceDefaultsSetupBanner({ current }: { current: InvoiceDocFields }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const missingKeys = useMemo<FieldKey[]>(
    () => (Object.keys(FIELD_META) as FieldKey[]).filter((k) => isMissing(current[k as FieldKey])),
    [current],
  );

  const [drafts, setDrafts] = useState<Record<FieldKey, string>>(() => ({
    payment_instructions: current.payment_instructions ?? '',
    terms: current.terms ?? '',
    policies: current.policies ?? '',
  }));

  if (missingKeys.length === 0) return null;

  function setField(k: FieldKey, v: string) {
    setDrafts((prev) => ({ ...prev, [k]: v }));
  }

  function handleSave() {
    startTransition(async () => {
      const result = await updateInvoiceDefaultsAction({
        payment_instructions: drafts.payment_instructions,
        terms: drafts.terms,
        policies: drafts.policies,
      });
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to save.');
        return;
      }
      toast.success('Saved as your default. Customers will see this on every invoice.');
      setOpen(false);
      router.refresh();
    });
  }

  const missingLabels = missingKeys.map((k) => FIELD_META[k].label.toLowerCase());
  const summary =
    missingLabels.length === 1
      ? `${missingLabels[0]} are`
      : missingLabels.length === 2
        ? `${missingLabels[0]} and ${missingLabels[1]} are`
        : `${missingLabels.slice(0, -1).join(', ')}, and ${missingLabels.at(-1)} are`;

  return (
    <>
      <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-700 dark:text-amber-300" />
          <div className="flex-1 space-y-2">
            <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
              Your customer won't know how to pay yet — {summary} blank.
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-200">
              Set your defaults once and they'll appear on every invoice and draw you send.
            </p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setOpen(true)}
              className="border-amber-300 bg-white hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:hover:bg-amber-900/60"
            >
              Set this up now
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Set your invoice defaults</DialogTitle>
            <DialogDescription>
              Saved once and applied to every invoice and draw going forward. You can change these
              anytime in Settings → Invoicing.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            {missingKeys.map((k) => {
              const meta = FIELD_META[k];
              return (
                <div key={k} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <Label htmlFor={`setup-${k}`} className="text-sm font-medium">
                      {meta.label}
                    </Label>
                    <button
                      type="button"
                      onClick={() => setField(k, SUGGESTED_INVOICE_DEFAULTS[k])}
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                      disabled={pending}
                    >
                      Use suggested text
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">{meta.description}</p>
                  <Textarea
                    id={`setup-${k}`}
                    value={drafts[k]}
                    onChange={(e) => setField(k, e.target.value)}
                    placeholder={meta.placeholder}
                    rows={meta.rows}
                    disabled={pending}
                    maxLength={4000}
                  />
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSave} disabled={pending}>
              {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save defaults
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
