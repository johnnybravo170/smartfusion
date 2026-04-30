'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { withFrom } from '@/lib/nav/from-link';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  createMilestoneInvoiceAction,
  generateFinalInvoiceAction,
} from '@/server/actions/invoices';

type InvoiceSummary = {
  id: string;
  status: string;
  doc_type: 'invoice' | 'draw' | 'final';
  tax_inclusive: boolean;
  percent_complete: number | null;
  amount_cents: number;
  tax_cents: number;
  customer_note: string | null;
  created_at: string;
};

function DrawForm({
  projectId,
  defaultLabel,
  defaultPercent,
  onDone,
}: {
  projectId: string;
  defaultLabel: string;
  defaultPercent: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [label, setLabel] = useState(defaultLabel);
  const [percentRaw, setPercentRaw] = useState(String(defaultPercent));
  const [items, setItems] = useState([{ id: crypto.randomUUID(), description: '', amountRaw: '' }]);

  function addItem() {
    setItems((prev) => [...prev, { id: crypto.randomUUID(), description: '', amountRaw: '' }]);
  }
  function removeItem(id: string) {
    setItems((prev) => prev.filter((item) => item.id !== id));
  }
  function updateItem(id: string, field: 'description' | 'amountRaw', value: string) {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, [field]: value } : item)));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const pctNum = percentRaw.trim() === '' ? null : Number(percentRaw);
    if (pctNum !== null && (Number.isNaN(pctNum) || pctNum < 0 || pctNum > 100)) {
      setError('% complete must be between 0 and 100.');
      return;
    }
    startTransition(async () => {
      const res = await createMilestoneInvoiceAction({
        projectId,
        label,
        percentComplete: pctNum,
        lineItems: items.map((item) => ({
          description: item.description,
          quantity: 1,
          unitPriceCents: Math.round(parseFloat(item.amountRaw || '0') * 100),
        })),
      });
      if (res.ok) {
        toast.success('Draw created.');
        router.push(
          withFrom(
            `/invoices/${res.id}`,
            `/projects/${projectId}?tab=invoices`,
            'Customer Billing',
          ),
        );
      } else {
        setError(res.error);
      }
    });
  }

  const total = items.reduce(
    (s, item) => s + Math.round(parseFloat(item.amountRaw || '0') * 100),
    0,
  );
  // GST is embedded in the total (tax-inclusive). Back-compute the
  // portion so the operator sees what's inside the customer's total.
  const gstEmbedded = Math.round((total * 0.05) / 1.05);

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <label htmlFor="draw-label" className="mb-1 block text-xs font-medium">
            Milestone Label
          </label>
          <Input
            id="draw-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Deposit, Draw #1, Rough-in complete"
            required
          />
        </div>
        <div>
          <label htmlFor="draw-percent" className="mb-1 block text-xs font-medium">
            % Complete <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <Input
            id="draw-percent"
            type="number"
            min="0"
            max="100"
            step="1"
            value={percentRaw}
            onChange={(e) => setPercentRaw(e.target.value)}
            placeholder="e.g. 40"
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">Line Items</p>
        <div className="space-y-2">
          {items.map((item) => (
            <div key={item.id} className="grid grid-cols-12 gap-2">
              <div className="col-span-7">
                <Input
                  value={item.description}
                  onChange={(e) => updateItem(item.id, 'description', e.target.value)}
                  placeholder="Description"
                  required
                />
              </div>
              <div className="col-span-4">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.amountRaw}
                  onChange={(e) => updateItem(item.id, 'amountRaw', e.target.value)}
                  placeholder="Amount ($)"
                  required
                />
              </div>
              <div className="col-span-1 flex items-center">
                {items.length > 1 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeItem(item.id)}
                  >
                    ×
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={addItem}>
          + Add line
        </Button>
      </div>

      {total > 0 && (
        <p className="text-sm">
          <span className="text-muted-foreground">Total: </span>
          <span className="font-medium">{formatCurrency(total)}</span>
          <span className="text-muted-foreground ml-2">
            (incl. {formatCurrency(gstEmbedded)} GST)
          </span>
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Creating…' : 'Create draw'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function InvoicesTab({
  projectId,
  invoices,
  contractRevenueCents,
}: {
  projectId: string;
  invoices: InvoiceSummary[];
  /** Sum of project_cost_lines + mgmt fee. Used to compute "% of contract"
   *  for each draw + the running total. Zero if the project hasn't been
   *  estimated yet. */
  contractRevenueCents: number;
}) {
  const router = useRouter();
  const [showDrawForm, setShowDrawForm] = useState(false);
  const [finalPending, startFinalTransition] = useTransition();

  function handleFinalInvoice() {
    startFinalTransition(async () => {
      const res = await generateFinalInvoiceAction({ projectId });
      if (res.ok) {
        toast.success('Final invoice created.');
        router.push(
          withFrom(
            `/invoices/${res.id}`,
            `/projects/${projectId}?tab=invoices`,
            'Customer Billing',
          ),
        );
      } else {
        toast.error(res.error);
      }
    });
  }

  // Split: doc_type='draw' is a milestone draw; everything else is a
  // regular invoice (incl. doc_type='final', or legacy untyped rows).
  const draws = invoices.filter((inv) => inv.doc_type === 'draw');
  const otherInvoices = invoices.filter((inv) => inv.doc_type !== 'draw');

  // For tax-inclusive draws, amount_cents IS the customer total. For
  // legacy rows that weren't tax-inclusive, total = amount + tax.
  function customerTotalCents(inv: InvoiceSummary) {
    return inv.tax_inclusive ? inv.amount_cents : inv.amount_cents + inv.tax_cents;
  }

  const drawsTotalCents = draws
    .filter((inv) => inv.status !== 'void')
    .reduce((s, inv) => s + customerTotalCents(inv), 0);
  const drawsPctOfContract =
    contractRevenueCents > 0 ? (drawsTotalCents / contractRevenueCents) * 100 : null;

  const drawCount = draws.filter((inv) => inv.status !== 'void').length;
  const defaultLabel = `Draw #${drawCount + 1}`;
  // Auto-bump the suggested % complete based on running total of the
  // contract billed so far. Operator can override.
  const defaultPercent =
    contractRevenueCents > 0
      ? Math.min(100, Math.round((drawsTotalCents / contractRevenueCents) * 100))
      : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-2">
        {!showDrawForm && (
          <Button size="sm" onClick={() => setShowDrawForm(true)}>
            + New draw
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={handleFinalInvoice} disabled={finalPending}>
          {finalPending ? 'Generating…' : 'Generate final invoice'}
        </Button>
      </div>

      {showDrawForm && (
        <DrawForm
          projectId={projectId}
          defaultLabel={defaultLabel}
          defaultPercent={defaultPercent}
          onDone={() => setShowDrawForm(false)}
        />
      )}

      {/* Draws section */}
      <section>
        <div className="mb-2 flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">
            Draws{' '}
            {drawCount > 0 ? (
              <span className="text-muted-foreground font-normal">({drawCount})</span>
            ) : null}
          </h3>
          {drawsTotalCents > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              Drawn to date{' '}
              <span className="font-semibold text-foreground">
                {formatCurrency(drawsTotalCents)}
              </span>
              {contractRevenueCents > 0 ? (
                <>
                  {' '}
                  of {formatCurrency(contractRevenueCents)}
                  {drawsPctOfContract !== null ? ` · ${Math.round(drawsPctOfContract)}%` : null}
                </>
              ) : null}
            </span>
          ) : null}
        </div>
        {draws.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No draws yet. Use "+ New draw" above to bill a milestone.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Label</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">% Complete</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-right font-medium">% of Contract</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {draws.map((inv) => {
                  const total = customerTotalCents(inv);
                  const pctOfContract =
                    contractRevenueCents > 0
                      ? Math.round((total / contractRevenueCents) * 100)
                      : null;
                  return (
                    <tr
                      key={inv.id}
                      className={`border-b last:border-0 ${inv.status === 'void' ? 'opacity-50' : ''}`}
                    >
                      <td className="px-3 py-2 font-medium">
                        {inv.customer_note || `Draw ${inv.id.slice(0, 8)}`}
                      </td>
                      <td className="px-3 py-2 capitalize text-muted-foreground">{inv.status}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {inv.percent_complete !== null ? `${inv.percent_complete}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCurrency(total)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {pctOfContract !== null ? `${pctOfContract}%` : '—'}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            router.push(
                              withFrom(
                                `/invoices/${inv.id}`,
                                `/projects/${projectId}?tab=invoices`,
                                'Customer Billing',
                              ),
                            )
                          }
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Final / other invoices section — only render when there's
          something to show, since most projects ship draws + one final. */}
      {otherInvoices.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Invoices</h3>
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
                {otherInvoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className={`border-b last:border-0 ${inv.status === 'void' ? 'opacity-50' : ''}`}
                  >
                    <td className="px-3 py-2 font-medium">
                      {inv.customer_note ||
                        (inv.doc_type === 'final'
                          ? 'Final invoice'
                          : `Invoice ${inv.id.slice(0, 8)}`)}
                    </td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{inv.status}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(inv.amount_cents)}</td>
                    <td className="px-3 py-2 text-right text-muted-foreground">
                      {formatCurrency(inv.tax_cents)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium">
                      {formatCurrency(customerTotalCents(inv))}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          router.push(
                            withFrom(
                              `/invoices/${inv.id}`,
                              `/projects/${projectId}?tab=invoices`,
                              'Customer Billing',
                            ),
                          )
                        }
                      >
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
