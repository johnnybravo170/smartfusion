'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { createMilestoneInvoiceAction, generateFinalInvoiceAction } from '@/server/actions/invoices';
import { formatCurrency } from '@/lib/pricing/calculator';

type InvoiceSummary = {
  id: string;
  status: string;
  amount_cents: number;
  tax_cents: number;
  customer_note: string | null;
  created_at: string;
};

function MilestoneForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [items, setItems] = useState([{ description: '', amountRaw: '' }]);

  function addItem() {
    setItems((prev) => [...prev, { description: '', amountRaw: '' }]);
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }
  function updateItem(i: number, field: string, value: string) {
    setItems((prev) => prev.map((item, idx) => (idx === i ? { ...item, [field]: value } : item)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const res = await createMilestoneInvoiceAction({
        projectId,
        label,
        lineItems: items.map((item) => ({
          description: item.description,
          quantity: 1,
          unitPriceCents: Math.round(parseFloat(item.amountRaw || '0') * 100),
        })),
      });
      if (res.ok) {
        toast.success('Invoice created.');
        router.push(`/invoices/${res.id}`);
      } else {
        setError(res.error);
      }
    });
  }

  const total = items.reduce((s, item) => s + Math.round(parseFloat(item.amountRaw || '0') * 100), 0);

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div>
        <label className="mb-1 block text-xs font-medium">Milestone Label</label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Deposit, Draw #1, Rough-in complete" required />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">Line Items</p>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <div className="col-span-7">
                <Input value={item.description} onChange={(e) => updateItem(i, 'description', e.target.value)} placeholder="Description" required />
              </div>
              <div className="col-span-4">
                <Input type="number" step="0.01" min="0" value={item.amountRaw} onChange={(e) => updateItem(i, 'amountRaw', e.target.value)} placeholder="Amount ($)" required />
              </div>
              <div className="col-span-1 flex items-center">
                {items.length > 1 && (
                  <Button type="button" size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => removeItem(i)}>×</Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={addItem}>+ Add line</Button>
      </div>

      {total > 0 && (
        <p className="text-sm">
          <span className="text-muted-foreground">Subtotal: </span>
          <span className="font-medium">{formatCurrency(total)}</span>
          <span className="text-muted-foreground ml-2">+ {formatCurrency(Math.round(total * 0.05))} GST</span>
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create invoice'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function InvoicesTab({
  projectId,
  invoices,
}: {
  projectId: string;
  invoices: InvoiceSummary[];
}) {
  const router = useRouter();
  const [showMilestoneForm, setShowMilestoneForm] = useState(false);
  const [finalPending, startFinalTransition] = useTransition();

  function handleFinalInvoice() {
    startFinalTransition(async () => {
      const res = await generateFinalInvoiceAction({ projectId });
      if (res.ok) {
        toast.success('Final invoice created.');
        router.push(`/invoices/${res.id}`);
      } else {
        toast.error(res.error);
      }
    });
  }

  const totalBilled = invoices
    .filter((inv) => inv.status !== 'void')
    .reduce((s, inv) => s + inv.amount_cents, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {!showMilestoneForm && (
          <Button size="sm" onClick={() => setShowMilestoneForm(true)}>+ Milestone invoice</Button>
        )}
        <Button size="sm" variant="outline" onClick={handleFinalInvoice} disabled={finalPending}>
          {finalPending ? 'Generating…' : 'Generate final invoice'}
        </Button>
      </div>

      {showMilestoneForm && (
        <MilestoneForm projectId={projectId} onDone={() => setShowMilestoneForm(false)} />
      )}

      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices yet for this project.</p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Label</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-right font-medium">Tax</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className={`border-b last:border-0 ${inv.status === 'void' ? 'opacity-50' : ''}`}>
                    <td className="px-3 py-2 font-medium">{inv.customer_note || `Invoice #${inv.id.slice(0, 8)}`}</td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{inv.status}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(inv.amount_cents)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">{formatCurrency(inv.tax_cents)}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(inv.amount_cents + inv.tax_cents)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" onClick={() => router.push(`/invoices/${inv.id}`)}>View</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {totalBilled > 0 && (
            <p className="text-right text-sm">
              <span className="text-muted-foreground">Total billed: </span>
              <span className="font-semibold">{formatCurrency(totalBilled)}</span>
            </p>
          )}
        </>
      )}
    </div>
  );
}
