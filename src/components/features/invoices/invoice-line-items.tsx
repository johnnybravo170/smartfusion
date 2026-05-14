'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { InvoiceLineItem } from '@/lib/db/queries/invoices';
import { formatCurrency } from '@/lib/pricing/calculator';
import { addInvoiceLineItemAction, removeInvoiceLineItemAction } from '@/server/actions/invoices';

export function InvoiceLineItems({
  invoiceId,
  lineItems,
  isDraft,
}: {
  invoiceId: string;
  lineItems: InvoiceLineItem[];
  isDraft: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showForm, setShowForm] = useState(false);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  function handleAdd() {
    const cents = Math.round(parseFloat(amount || '0') * 100);
    if (!description.trim() || cents <= 0) {
      toast.error('Enter a description and amount.');
      return;
    }

    startTransition(async () => {
      const result = await addInvoiceLineItemAction({
        invoiceId,
        description: description.trim(),
        quantity: 1,
        unitPriceCents: cents,
      });
      if (!result.ok) {
        toast.error(result.error);
      } else {
        setDescription('');
        setAmount('');
        setShowForm(false);
        router.refresh();
      }
    });
  }

  function handleRemove(index: number) {
    startTransition(async () => {
      const result = await removeInvoiceLineItemAction({ invoiceId, itemIndex: index });
      if (!result.ok) {
        toast.error(result.error);
      } else {
        router.refresh();
      }
    });
  }

  const lineItemsTotal = lineItems.reduce((sum, li) => sum + li.total_cents, 0);

  return (
    <div className="flex flex-col gap-2">
      {lineItems.length > 0 && (
        <div className="space-y-1">
          {lineItems.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: line items have no stable id
            <div key={i} className="flex items-center justify-between text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {item.description}
                  {item.quantity > 1 ? ` (x${item.quantity})` : ''}
                </span>
                {isDraft && (
                  <button
                    type="button"
                    onClick={() => handleRemove(i)}
                    disabled={pending}
                    className="text-muted-foreground hover:text-destructive disabled:opacity-50"
                    aria-label={`Remove ${item.description}`}
                  >
                    <Trash2 className="size-3" />
                  </button>
                )}
              </div>
              <span>{formatCurrency(item.total_cents)}</span>
            </div>
          ))}
          <div className="flex items-center justify-between border-t pt-1 text-sm font-medium">
            <span className="text-muted-foreground">Add-ons subtotal</span>
            <span>{formatCurrency(lineItemsTotal)}</span>
          </div>
        </div>
      )}

      {isDraft && !showForm && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-fit"
          onClick={() => setShowForm(true)}
        >
          <Plus className="size-3.5" />
          Add item
        </Button>
      )}

      {showForm && (
        <div className="flex items-end gap-2 rounded-md border p-2">
          <div className="flex-1">
            <label
              htmlFor="li-description"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Description
            </label>
            <Input
              id="li-description"
              className="h-8 text-sm"
              placeholder="e.g. Extra materials"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="w-28">
            <label
              htmlFor="li-amount"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Amount ($)
            </label>
            <Input
              id="li-amount"
              className="h-8 text-sm"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={pending}
            />
          </div>
          <Button type="button" size="sm" onClick={handleAdd} disabled={pending}>
            Add
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowForm(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
