'use client';

import { Loader2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type InvoiceDocFields,
  SUGGESTED_INVOICE_DEFAULTS,
} from '@/lib/invoices/default-doc-fields';
import { updateInvoiceDefaultsAction } from '@/server/actions/settings';

type FieldKey = keyof InvoiceDocFields;

const FIELDS: { key: FieldKey; label: string; description: string; placeholder: string }[] = [
  {
    key: 'payment_instructions',
    label: 'Payment instructions',
    description: 'How customers pay you (e-transfer, cheque, mailing address).',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.payment_instructions,
  },
  {
    key: 'terms',
    label: 'Payment terms',
    description: 'When payment is due (e.g. "Due within 30 days").',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.terms,
  },
  {
    key: 'policies',
    label: 'Policies',
    description: 'Late fees, returns, NSF cheques, warranty terms.',
    placeholder: SUGGESTED_INVOICE_DEFAULTS.policies,
  },
];

export function InvoicingDefaultsForm({ initial }: { initial: InvoiceDocFields }) {
  const [pending, startTransition] = useTransition();
  const [values, setValues] = useState<InvoiceDocFields>({
    payment_instructions: initial.payment_instructions ?? '',
    terms: initial.terms ?? '',
    policies: initial.policies ?? '',
  });

  function setField(key: FieldKey, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function handleSave() {
    startTransition(async () => {
      const result = await updateInvoiceDefaultsAction(values);
      if (!result.ok) {
        toast.error(result.error ?? 'Failed to save.');
        return;
      }
      toast.success('Invoice defaults saved.');
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invoice & draw defaults</CardTitle>
        <CardDescription>
          These appear on every customer-facing invoice and draw — both the email and the public
          view. You can fill them now or fill them inline when sending an invoice for the first
          time.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {FIELDS.map((f) => (
          <div key={f.key} className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={f.key} className="text-sm font-medium">
                {f.label}
              </Label>
              <button
                type="button"
                onClick={() => setField(f.key, SUGGESTED_INVOICE_DEFAULTS[f.key])}
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                disabled={pending}
              >
                Use suggested text
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{f.description}</p>
            <Textarea
              id={f.key}
              value={values[f.key] ?? ''}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder={f.placeholder}
              rows={f.key === 'payment_instructions' ? 5 : 3}
              disabled={pending}
              maxLength={4000}
            />
          </div>
        ))}
        <Button onClick={handleSave} disabled={pending} size="sm">
          {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
          Save defaults
        </Button>
      </CardContent>
    </Card>
  );
}
