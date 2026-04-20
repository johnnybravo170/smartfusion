'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  createPurchaseOrderAction,
  updatePurchaseOrderStatusAction,
  upsertBillAction,
  deleteBillAction,
} from '@/server/actions/project-cost-control';
import type { PurchaseOrderRow, PurchaseOrderStatus } from '@/lib/db/queries/purchase-orders';
import type { ProjectBillRow } from '@/lib/db/queries/project-bills';
import { formatCurrency } from '@/lib/pricing/calculator';

function displayToCents(val: string) {
  return Math.round(parseFloat(val || '0') * 100);
}

const STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  acknowledged: 'Acknowledged',
  received: 'Received',
  closed: 'Closed',
};

const STATUS_NEXT: Record<PurchaseOrderStatus, PurchaseOrderStatus | null> = {
  draft: 'sent',
  sent: 'acknowledged',
  acknowledged: 'received',
  received: 'closed',
  closed: null,
};

// ─── PO form ──────────────────────────────────────────────────────────────────

function POForm({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [vendor, setVendor] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [issuedDate, setIssuedDate] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([{ label: '', qty: '1', unit: 'item', costRaw: '' }]);

  function addItem() {
    setItems((prev) => [...prev, { label: '', qty: '1', unit: 'item', costRaw: '' }]);
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
      const res = await createPurchaseOrderAction({
        project_id: projectId,
        vendor,
        po_number: poNumber,
        issued_date: issuedDate,
        expected_date: expectedDate,
        notes,
        items: items.map((item) => ({
          label: item.label,
          qty: parseFloat(item.qty || '1'),
          unit: item.unit,
          unit_cost_cents: displayToCents(item.costRaw),
        })),
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  const total = items.reduce(
    (s, item) => s + Math.round(parseFloat(item.qty || '1') * displayToCents(item.costRaw)),
    0,
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Vendor</label>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Supplier name" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">PO #</label>
          <Input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="Optional" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Issue Date</label>
          <Input type="date" value={issuedDate} onChange={(e) => setIssuedDate(e.target.value)} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Expected Date</label>
          <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        </div>
        <div className="sm:col-span-3">
          <label className="mb-1 block text-xs font-medium">Notes</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">Line Items</p>
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <div className="col-span-4">
                <Input
                  value={item.label}
                  onChange={(e) => updateItem(i, 'label', e.target.value)}
                  placeholder="Description"
                  required
                />
              </div>
              <div className="col-span-2">
                <Input
                  type="number" step="0.01" min="0.01"
                  value={item.qty}
                  onChange={(e) => updateItem(i, 'qty', e.target.value)}
                  placeholder="Qty"
                />
              </div>
              <div className="col-span-2">
                <Input
                  value={item.unit}
                  onChange={(e) => updateItem(i, 'unit', e.target.value)}
                  placeholder="unit"
                />
              </div>
              <div className="col-span-3">
                <Input
                  type="number" step="0.01" min="0"
                  value={item.costRaw}
                  onChange={(e) => updateItem(i, 'costRaw', e.target.value)}
                  placeholder="Cost / unit"
                />
              </div>
              <div className="col-span-1 flex items-center">
                {items.length > 1 && (
                  <Button type="button" size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => removeItem(i)}>×</Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={addItem}>+ Add item</Button>
      </div>

      {total > 0 && (
        <p className="text-sm font-medium">Total: {formatCurrency(total)}</p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Creating…' : 'Create PO'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

// ─── Bill form ────────────────────────────────────────────────────────────────

function BillForm({
  projectId,
  initial,
  onDone,
}: {
  projectId: string;
  initial?: ProjectBillRow;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [billDate, setBillDate] = useState(initial?.bill_date ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [amountRaw, setAmountRaw] = useState(initial ? (initial.amount_cents / 100).toFixed(2) : '');
  const [costCode, setCostCode] = useState(initial?.cost_code ?? '');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const res = await upsertBillAction({
        id: initial?.id,
        project_id: projectId,
        vendor,
        bill_date: billDate,
        description,
        amount_cents: displayToCents(amountRaw),
        cost_code: costCode,
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Vendor</label>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor name" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Date</label>
          <Input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Amount ($)</label>
          <Input type="number" step="0.01" min="0.01" value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)} placeholder="0.00" required />
        </div>
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Cost Code</label>
          <Input value={costCode} onChange={(e) => setCostCode(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : initial ? 'Update' : 'Log bill'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CostsTab({
  projectId,
  purchaseOrders,
  bills,
}: {
  projectId: string;
  purchaseOrders: PurchaseOrderRow[];
  bills: ProjectBillRow[];
}) {
  const [showPOForm, setShowPOForm] = useState(false);
  const [showBillForm, setShowBillForm] = useState(false);
  const [editingBill, setEditingBill] = useState<ProjectBillRow | null>(null);
  const [, startTransition] = useTransition();

  function advancePOStatus(po: PurchaseOrderRow) {
    const next = STATUS_NEXT[po.status];
    if (!next) return;
    startTransition(async () => { await updatePurchaseOrderStatusAction(po.id, next, projectId); });
  }

  function handleDeleteBill(id: string) {
    if (!confirm('Delete this bill?')) return;
    startTransition(async () => { await deleteBillAction(id, projectId); });
  }

  const totalPOs = purchaseOrders
    .filter((po) => ['sent', 'acknowledged', 'received'].includes(po.status))
    .reduce((s, po) => s + po.total_cents, 0);

  const totalBills = bills.reduce((s, b) => s + b.amount_cents, 0);

  return (
    <div className="space-y-8">
      {/* Purchase Orders */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Purchase Orders</h3>
          {!showPOForm && (
            <Button size="sm" onClick={() => setShowPOForm(true)}>+ New PO</Button>
          )}
        </div>

        {showPOForm && (
          <div className="mb-4">
            <POForm projectId={projectId} onDone={() => setShowPOForm(false)} />
          </div>
        )}

        {purchaseOrders.length === 0 ? (
          <p className="text-sm text-muted-foreground">No purchase orders yet.</p>
        ) : (
          <div className="space-y-3">
            {purchaseOrders.map((po) => {
              const next = STATUS_NEXT[po.status];
              return (
                <div key={po.id} className="rounded-md border">
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <div>
                      <p className="font-medium">{po.vendor}</p>
                      <p className="text-xs text-muted-foreground">
                        {po.po_number ? `PO #${po.po_number} · ` : ''}
                        {STATUS_LABELS[po.status]}
                        {po.expected_date ? ` · Expected ${po.expected_date}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <p className="font-semibold">{formatCurrency(po.total_cents)}</p>
                      {next && (
                        <Button size="xs" variant="outline" onClick={() => advancePOStatus(po)}>
                          Mark {STATUS_LABELS[next]}
                        </Button>
                      )}
                    </div>
                  </div>
                  {po.items.length > 0 && (
                    <div className="border-t px-4 py-2">
                      <table className="w-full text-xs">
                        <tbody>
                          {po.items.map((item) => (
                            <tr key={item.id} className="border-b last:border-0">
                              <td className="py-1 pr-4">{item.label}</td>
                              <td className="py-1 pr-4 text-muted-foreground">{Number(item.qty)} {item.unit}</td>
                              <td className="py-1 text-right">{formatCurrency(item.line_total_cents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {totalPOs > 0 && (
              <p className="text-right text-sm">
                <span className="text-muted-foreground">Committed (open POs): </span>
                <span className="font-semibold">{formatCurrency(totalPOs)}</span>
              </p>
            )}
          </div>
        )}
      </section>

      {/* Bills */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Bills & Sub Invoices</h3>
          {!showBillForm && !editingBill && (
            <Button size="sm" onClick={() => setShowBillForm(true)}>+ Log bill</Button>
          )}
        </div>

        {(showBillForm || editingBill) && (
          <div className="mb-4">
            <BillForm
              projectId={projectId}
              initial={editingBill ?? undefined}
              onDone={() => { setShowBillForm(false); setEditingBill(null); }}
            />
          </div>
        )}

        {bills.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bills logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {bills.map((bill) => (
                  <tr key={bill.id} className="border-b last:border-0">
                    <td className="px-3 py-2 font-medium">{bill.vendor}</td>
                    <td className="px-3 py-2 text-muted-foreground">{bill.bill_date}</td>
                    <td className="px-3 py-2 text-muted-foreground">{bill.description || '—'}</td>
                    <td className="px-3 py-2 capitalize text-muted-foreground">{bill.status}</td>
                    <td className="px-3 py-2 text-right font-medium">{formatCurrency(bill.amount_cents)}</td>
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <Button size="xs" variant="ghost" onClick={() => { setEditingBill(bill); setShowBillForm(false); }}>Edit</Button>
                        <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleDeleteBill(bill.id)}>Del</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="border-t px-3 py-2 text-right text-sm">
              <span className="text-muted-foreground">Total billed: </span>
              <span className="font-semibold">{formatCurrency(totalBills)}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
