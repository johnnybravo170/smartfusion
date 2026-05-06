'use client';

import { ChevronDown, ChevronRight, Loader2, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { InvoiceDocFields } from '@/lib/invoices/default-doc-fields';
import { updateInvoiceOverridesAction } from '@/server/actions/invoices';

type FieldKey = keyof InvoiceDocFields;

const FIELDS: { key: FieldKey; label: string; description: string; rows: number }[] = [
  {
    key: 'payment_instructions',
    label: 'Payment instructions',
    description: 'How customers pay you for this invoice.',
    rows: 5,
  },
  {
    key: 'terms',
    label: 'Payment terms',
    description: 'When payment is due (e.g. "Due on receipt", "Net 15").',
    rows: 3,
  },
  {
    key: 'policies',
    label: 'Policies',
    description: 'Late fees, NSF cheques, warranty terms.',
    rows: 3,
  },
];

export function InvoiceOverridesEditor({
  invoiceId,
  override,
  tenant,
}: {
  invoiceId: string;
  override: InvoiceDocFields;
  tenant: InvoiceDocFields;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [drafts, setDrafts] = useState<Record<FieldKey, string>>({
    payment_instructions: override.payment_instructions ?? '',
    terms: override.terms ?? '',
    policies: override.policies ?? '',
  });

  const overrideCount = (Object.keys(drafts) as FieldKey[]).filter(
    (k) => (override[k] ?? '').trim().length > 0,
  ).length;

  function setField(k: FieldKey, v: string) {
    setDrafts((prev) => ({ ...prev, [k]: v }));
  }

  function handleClearOne(k: FieldKey) {
    setDrafts((prev) => ({ ...prev, [k]: '' }));
  }

  function handleSave() {
    startTransition(async () => {
      const result = await updateInvoiceOverridesAction({
        invoiceId,
        payment_instructions: drafts.payment_instructions,
        terms: drafts.terms,
        policies: drafts.policies,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Overrides saved.');
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="cursor-pointer pb-3" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Override defaults for this invoice
            {overrideCount > 0 ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                {overrideCount} active
              </span>
            ) : null}
          </CardTitle>
        </div>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-5">
          <p className="text-xs text-muted-foreground">
            Anything you set here replaces the tenant default for this invoice only. Leave a field
            blank to fall back to the default in Settings → Invoicing.
          </p>
          {FIELDS.map((f) => {
            const isOverridden = (override[f.key] ?? '').trim().length > 0;
            const fallback = (tenant[f.key] ?? '').trim();
            return (
              <div key={f.key} className="space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor={`ov-${f.key}`} className="text-sm font-medium">
                    {f.label}
                    {isOverridden ? (
                      <span className="ml-2 text-xs font-normal text-amber-700 dark:text-amber-300">
                        Override active
                      </span>
                    ) : null}
                  </Label>
                  {drafts[f.key].length > 0 ? (
                    <button
                      type="button"
                      onClick={() => handleClearOne(f.key)}
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                      disabled={pending}
                    >
                      <RotateCcw className="size-3" />
                      Use default
                    </button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{f.description}</p>
                <Textarea
                  id={`ov-${f.key}`}
                  value={drafts[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={fallback || `(no default set — fill in Settings → Invoicing)`}
                  rows={f.rows}
                  disabled={pending}
                  maxLength={4000}
                />
                {drafts[f.key].length === 0 && fallback.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Falls back to your tenant default.
                  </p>
                ) : null}
              </div>
            );
          })}
          <div className="flex items-center gap-2 pt-1">
            <Button type="button" onClick={handleSave} disabled={pending} size="sm">
              {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              Save overrides
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Close
            </Button>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}
