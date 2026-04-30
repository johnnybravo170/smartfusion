'use client';

import { Paperclip } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ProjectBillRow } from '@/lib/db/queries/project-bills';
import type { SubQuoteRow } from '@/lib/db/queries/project-sub-quotes';
import type { PurchaseOrderRow, PurchaseOrderStatus } from '@/lib/db/queries/purchase-orders';
import { formatCurrency, formatCurrencyCompact } from '@/lib/pricing/calculator';
import {
  createPurchaseOrderAction,
  deleteBillAction,
  updatePurchaseOrderStatusAction,
  upsertBillWithAttachmentAction,
} from '@/server/actions/project-cost-control';
import { CostsByCategoryView } from './costs-by-category-view';
import { type CostsSubtabKey, CostsSubtabs } from './costs-subtabs';
import { type ExpenseItem, ExpensesSection } from './expenses-section';
import { SubQuotesSection } from './sub-quotes-section';

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
          <label htmlFor="po-vendor" className="mb-1 block text-xs font-medium">
            Vendor
          </label>
          <Input
            id="po-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Supplier name"
            required
          />
        </div>
        <div>
          <label htmlFor="po-number" className="mb-1 block text-xs font-medium">
            PO #
          </label>
          <Input
            id="po-number"
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label htmlFor="po-issued" className="mb-1 block text-xs font-medium">
            Issue Date
          </label>
          <Input
            id="po-issued"
            type="date"
            value={issuedDate}
            onChange={(e) => setIssuedDate(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="po-expected" className="mb-1 block text-xs font-medium">
            Expected Date
          </label>
          <Input
            id="po-expected"
            type="date"
            value={expectedDate}
            onChange={(e) => setExpectedDate(e.target.value)}
          />
        </div>
        <div className="sm:col-span-3">
          <label htmlFor="po-notes" className="mb-1 block text-xs font-medium">
            Notes
          </label>
          <Input
            id="po-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
          />
        </div>
      </div>

      <div>
        <p className="mb-2 text-xs font-medium">Line Items</p>
        <div className="space-y-2">
          {items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable ephemeral list, no external IDs
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
                  type="number"
                  step="0.01"
                  min="0.01"
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
                  type="number"
                  step="0.01"
                  min="0"
                  value={item.costRaw}
                  onChange={(e) => updateItem(i, 'costRaw', e.target.value)}
                  placeholder="Cost / unit"
                />
              </div>
              <div className="col-span-1 flex items-center">
                {items.length > 1 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => removeItem(i)}
                  >
                    ×
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Button type="button" size="sm" variant="ghost" className="mt-2" onClick={addItem}>
          + Add item
        </Button>
      </div>

      {total > 0 && <p className="text-sm font-medium">Total: {formatCurrency(total)}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Creating…' : 'Create PO'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Bill form ────────────────────────────────────────────────────────────────

const GST_RATE = 0.05;

function BillForm({
  projectId,
  buckets,
  initial,
  onDone,
}: {
  projectId: string;
  buckets: Array<{ id: string; name: string; cost_lines: Array<{ id: string; label: string }> }>;
  initial?: ProjectBillRow;
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [billDate, setBillDate] = useState(initial?.bill_date ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [subtotalRaw, setSubtotalRaw] = useState(
    initial ? (initial.amount_cents / 100).toFixed(2) : '',
  );
  const [hasGst, setHasGst] = useState((initial?.gst_cents ?? 0) > 0 || !initial);
  const [gstRaw, setGstRaw] = useState(
    initial && initial.gst_cents > 0 ? (initial.gst_cents / 100).toFixed(2) : '',
  );
  const [bucketId, setBucketId] = useState(initial?.budget_category_id ?? '');
  const [costLineId, setCostLineId] = useState(initial?.cost_line_id ?? '');
  const [costCode, setCostCode] = useState(initial?.cost_code ?? '');
  const [vendorGstNumber, setVendorGstNumber] = useState(initial?.vendor_gst_number ?? '');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);

  // Auto-compute GST whenever subtotal changes, but only if the user hasn't
  // overridden it manually.
  const [gstManual, setGstManual] = useState(initial?.gst_cents != null && initial.gst_cents > 0);

  function handleSubtotalChange(val: string) {
    setSubtotalRaw(val);
    if (hasGst && !gstManual) {
      const sub = parseFloat(val) || 0;
      setGstRaw(sub > 0 ? (sub * GST_RATE).toFixed(2) : '');
    }
  }

  function handleGstChange(val: string) {
    setGstRaw(val);
    setGstManual(true);
  }

  function handleHasGstToggle(checked: boolean) {
    setHasGst(checked);
    if (!checked) {
      setGstRaw('');
      setGstManual(false);
    } else if (!gstManual) {
      const sub = parseFloat(subtotalRaw) || 0;
      setGstRaw(sub > 0 ? (sub * GST_RATE).toFixed(2) : '');
    }
  }

  const subtotalCents = displayToCents(subtotalRaw);
  const gstCents = hasGst ? displayToCents(gstRaw) : 0;
  const totalCents = subtotalCents + gstCents;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const fd = new FormData();
      if (initial?.id) fd.set('id', initial.id);
      fd.set('project_id', projectId);
      fd.set('vendor', vendor);
      fd.set('bill_date', billDate);
      fd.set('description', description);
      fd.set('amount_cents', String(subtotalCents));
      fd.set('gst_cents', String(gstCents));
      fd.set('budget_category_id', bucketId);
      if (costLineId) fd.set('cost_line_id', costLineId);
      fd.set('cost_code', costCode);
      fd.set('vendor_gst_number', vendorGstNumber);
      if (attachmentFile) fd.set('attachment', attachmentFile);

      const res = await upsertBillWithAttachmentAction(fd);
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label htmlFor="bill-vendor" className="mb-1 block text-xs font-medium">
            Vendor
          </label>
          <Input
            id="bill-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Vendor name"
            required
          />
        </div>
        <div>
          <label htmlFor="bill-date" className="mb-1 block text-xs font-medium">
            Date
          </label>
          <Input
            id="bill-date"
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            required
          />
        </div>
        {buckets.length > 0 && (
          <div>
            <label htmlFor="bill-bucket" className="mb-1 block text-xs font-medium">
              Bucket
            </label>
            <select
              id="bill-bucket"
              value={bucketId}
              onChange={(e) => {
                setBucketId(e.target.value);
                setCostLineId('');
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">— none —</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {(() => {
          const lines = buckets.find((b) => b.id === bucketId)?.cost_lines ?? [];
          if (!bucketId || lines.length === 0) return null;
          return (
            <div>
              <label htmlFor="bill-line" className="mb-1 block text-xs font-medium">
                Line item (optional)
              </label>
              <select
                id="bill-line"
                value={costLineId}
                onChange={(e) => setCostLineId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">— bucket only —</option>
                {lines.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })()}
        <div className="sm:col-span-2">
          <label htmlFor="bill-desc" className="mb-1 block text-xs font-medium">
            Description
          </label>
          <Input
            id="bill-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <label htmlFor="bill-code" className="mb-1 block text-xs font-medium">
            Cost Code
          </label>
          <Input
            id="bill-code"
            value={costCode}
            onChange={(e) => setCostCode(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="bill-vendor-gst" className="mb-1 block text-xs font-medium">
            Vendor GST # (optional)
          </label>
          <Input
            id="bill-vendor-gst"
            value={vendorGstNumber}
            onChange={(e) => setVendorGstNumber(e.target.value)}
            placeholder="e.g. 123456789 RT0001"
          />
        </div>
      </div>

      {/* Amount + GST */}
      <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="bill-subtotal" className="mb-1 block text-xs font-medium">
              Subtotal ($)
            </label>
            <Input
              id="bill-subtotal"
              type="number"
              step="0.01"
              min="0.01"
              value={subtotalRaw}
              onChange={(e) => handleSubtotalChange(e.target.value)}
              placeholder="0.00"
              required
            />
          </div>
          <div>
            <label htmlFor="bill-gst" className="mb-1 block text-xs font-medium">
              GST ($)
              <span className="ml-1 font-normal text-muted-foreground">5%</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="bill-has-gst"
                checked={hasGst}
                onChange={(e) => handleHasGstToggle(e.target.checked)}
                className="size-4 shrink-0"
              />
              {hasGst ? (
                <Input
                  id="bill-gst"
                  type="number"
                  step="0.01"
                  min="0"
                  value={gstRaw}
                  onChange={(e) => handleGstChange(e.target.value)}
                  placeholder="0.00"
                />
              ) : (
                <span className="text-sm text-muted-foreground">No GST</span>
              )}
            </div>
          </div>
          {totalCents > 0 && (
            <div className="flex items-end pb-1 sm:col-span-2">
              <p className="text-sm font-semibold">
                Total: {formatCurrency(totalCents)}
                {gstCents > 0 && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    (incl. {formatCurrency(gstCents)} GST)
                  </span>
                )}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Attachment */}
      <div>
        <p className="mb-1 text-xs font-medium">Attachment</p>
        {initial?.attachment_storage_path && !attachmentFile ? (
          <p className="mb-1 text-xs text-muted-foreground">
            Existing attachment on file.{' '}
            <button type="button" className="underline" onClick={() => fileRef.current?.click()}>
              Replace
            </button>
          </p>
        ) : null}
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/30"
          onClick={() => fileRef.current?.click()}
        >
          <Paperclip className="size-4 shrink-0" />
          {attachmentFile ? (
            <span className="truncate text-foreground">{attachmentFile.name}</span>
          ) : (
            <span>Attach invoice PDF or photo</span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setAttachmentFile(f);
            e.target.value = '';
          }}
        />
        {attachmentFile && (
          <button
            type="button"
            className="mt-1 text-xs text-muted-foreground underline"
            onClick={() => setAttachmentFile(null)}
          >
            Remove
          </button>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : initial ? 'Update' : 'Log bill'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function CostsTab({
  projectId,
  purchaseOrders,
  bills,
  subQuotes,
  expenses,
  buckets,
}: {
  projectId: string;
  purchaseOrders: PurchaseOrderRow[];
  bills: ProjectBillRow[];
  subQuotes: SubQuoteRow[];
  expenses: ExpenseItem[];
  buckets: Array<{
    id: string;
    name: string;
    section: 'interior' | 'exterior' | 'general';
    cost_lines: Array<{ id: string; label: string }>;
  }>;
}) {
  const [showPOForm, setShowPOForm] = useState(false);
  const [showBillForm, setShowBillForm] = useState(false);
  const [editingBill, setEditingBill] = useState<ProjectBillRow | null>(null);
  const [, startTransition] = useTransition();

  function advancePOStatus(po: PurchaseOrderRow) {
    const next = STATUS_NEXT[po.status];
    if (!next) return;
    startTransition(async () => {
      await updatePurchaseOrderStatusAction(po.id, next, projectId);
    });
  }

  function handleDeleteBill(id: string) {
    if (!confirm('Delete this bill?')) return;
    startTransition(async () => {
      await deleteBillAction(id, projectId);
    });
  }

  const totalPOs = purchaseOrders
    .filter((po) => ['sent', 'acknowledged', 'received'].includes(po.status))
    .reduce((s, po) => s + po.total_cents, 0);

  const totalBills = bills.reduce((s, b) => s + b.amount_cents, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const committedTotal = subQuotes
    .filter((q) => q.status === 'accepted')
    .reduce((s, q) => s + q.total_cents, 0);

  const searchParams = useSearchParams();
  const sub: CostsSubtabKey = (() => {
    const raw = searchParams.get('sub');
    if (raw === 'quotes' || raw === 'pos' || raw === 'bills' || raw === 'expenses') return raw;
    // No explicit subtab — pick the first one that has content so the
    // page isn't a wall of "No quotes yet" when there are 18 bills sitting
    // one click away. Quotes still wins on a tie since it's the most
    // common entry point for new spend.
    if (subQuotes.length > 0) return 'quotes';
    if (bills.length > 0) return 'bills';
    if (expenses.length > 0) return 'expenses';
    if (purchaseOrders.length > 0) return 'pos';
    return 'quotes';
  })();
  const groupByCategory = searchParams.get('view') === 'category';
  // Drill-down filter: Budget tab links here with `?focus=<budget_category_id>`
  // (bucket-level) or `?focus_line=<cost_line_id>` (line-level) so the operator
  // lands on Spend already filtered. Bills, expenses, and vendor-quote
  // allocations carry budget_category_id directly. POs match through their
  // line items' cost_line.budget_category_id (resolved in
  // listPurchaseOrders). focus_line is finer-grained — applied on top of /
  // instead of focus.
  const focusCategoryId = searchParams.get('focus');
  const focusLineId = searchParams.get('focus_line');
  const filteredBills = focusLineId
    ? bills.filter((b) => b.cost_line_id === focusLineId)
    : focusCategoryId
      ? bills.filter((b) => b.budget_category_id === focusCategoryId)
      : bills;
  const filteredExpenses = focusLineId
    ? expenses.filter((e) => e.cost_line_id === focusLineId)
    : focusCategoryId
      ? expenses.filter((e) => e.budget_category_id === focusCategoryId)
      : expenses;
  const filteredSubQuotes = focusLineId
    ? // Sub-quote allocations are per-bucket only — hide all when filtering
      // to a single line. Honest empty state beats "every quote against this
      // bucket also lights up under every line", which would be misleading.
      []
    : focusCategoryId
      ? subQuotes.filter((q) => q.allocations.some((a) => a.budget_category_id === focusCategoryId))
      : subQuotes;
  const filteredPurchaseOrders = focusLineId
    ? purchaseOrders.filter((po) => po.items.some((it) => it.cost_line_id === focusLineId))
    : focusCategoryId
      ? purchaseOrders.filter((po) =>
          po.items.some((it) => it.budget_category_id === focusCategoryId),
        )
      : purchaseOrders;
  const focusCategoryName = focusCategoryId
    ? buckets.find((b) => b.id === focusCategoryId)?.name
    : null;
  const focusLineLabel = focusLineId
    ? buckets.flatMap((b) => b.cost_lines).find((l) => l.id === focusLineId)?.label
    : null;
  const subtabCounts: Record<CostsSubtabKey, number> = {
    quotes: filteredSubQuotes.length,
    pos: filteredPurchaseOrders.length,
    bills: filteredBills.length,
    expenses: filteredExpenses.length,
  };

  return (
    <div className="space-y-4">
      {/* Summary strip. Narrow screens get a 2-column grid (readable and
          predictable); sm+ flows to a single row so the whole story is on
          one line where there's space. formatCurrencyCompact drops .00 on
          whole-dollar amounts to save width on mobile. */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border bg-muted/20 px-4 py-3 text-sm sm:flex sm:flex-wrap sm:gap-4">
        <div>
          <span className="text-muted-foreground">Committed</span>{' '}
          <span className="font-semibold tabular-nums">
            {formatCurrencyCompact(committedTotal)}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">PO&apos;d</span>{' '}
          <span className="font-semibold tabular-nums">{formatCurrencyCompact(totalPOs)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Billed</span>{' '}
          <span className="font-semibold tabular-nums">{formatCurrencyCompact(totalBills)}</span>
        </div>
        <div>
          <span className="text-muted-foreground">Paid</span>{' '}
          <span className="font-semibold tabular-nums">{formatCurrencyCompact(totalExpenses)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex rounded-md border bg-muted/30 p-0.5 text-xs">
          <a
            href={`/projects/${projectId}?tab=costs${focusCategoryId ? `&focus=${focusCategoryId}` : ''}${focusLineId ? `&focus_line=${focusLineId}` : ''}`}
            className={`rounded px-2 py-1 ${!groupByCategory ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            By type
          </a>
          <a
            href={`/projects/${projectId}?tab=costs&view=category${focusCategoryId ? `&focus=${focusCategoryId}` : ''}${focusLineId ? `&focus_line=${focusLineId}` : ''}`}
            className={`rounded px-2 py-1 ${groupByCategory ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
          >
            By category
          </a>
        </div>
      </div>

      {!groupByCategory ? <CostsSubtabs counts={subtabCounts} /> : null}

      {focusLineId && focusLineLabel ? (
        <div className="flex items-center justify-between rounded-md border border-amber-300/60 bg-amber-50/50 px-3 py-2 text-xs">
          <span>
            Filtered to line item <span className="font-semibold">{focusLineLabel}</span>
          </span>
          <a
            href={`/projects/${projectId}?tab=costs&sub=${sub}`}
            className="text-primary hover:underline"
          >
            Clear filter
          </a>
        </div>
      ) : focusCategoryId && focusCategoryName ? (
        <div className="flex items-center justify-between rounded-md border border-amber-300/60 bg-amber-50/50 px-3 py-2 text-xs">
          <span>
            Filtered to <span className="font-semibold">{focusCategoryName}</span>
          </span>
          <a
            href={`/projects/${projectId}?tab=costs&sub=${sub}`}
            className="text-primary hover:underline"
          >
            Clear filter
          </a>
        </div>
      ) : null}

      {groupByCategory ? (
        <CostsByCategoryView
          buckets={buckets}
          bills={filteredBills}
          expenses={filteredExpenses}
          subQuotes={filteredSubQuotes}
          purchaseOrders={filteredPurchaseOrders}
        />
      ) : null}

      {!groupByCategory && sub === 'quotes' ? (
        <SubQuotesSection projectId={projectId} subQuotes={filteredSubQuotes} buckets={buckets} />
      ) : null}

      {!groupByCategory && sub === 'expenses' ? (
        <ExpensesSection
          projectId={projectId}
          buckets={buckets.map((b) => ({
            id: b.id,
            name: b.name,
            cost_lines: b.cost_lines,
          }))}
          expenses={filteredExpenses}
        />
      ) : null}

      {!groupByCategory && sub === 'pos' ? (
        /* Purchase Orders */
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Purchase Orders</h3>
            {!showPOForm && (
              <Button size="sm" onClick={() => setShowPOForm(true)}>
                + New PO
              </Button>
            )}
          </div>

          {showPOForm && (
            <div className="mb-4">
              <POForm projectId={projectId} onDone={() => setShowPOForm(false)} />
            </div>
          )}

          {filteredPurchaseOrders.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {focusCategoryName
                ? `No purchase orders in ${focusCategoryName}.`
                : 'No purchase orders yet.'}
            </p>
          ) : (
            <div className="space-y-3">
              {filteredPurchaseOrders.map((po) => {
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
                                <td className="py-1 pr-4 text-muted-foreground">
                                  {Number(item.qty)} {item.unit}
                                </td>
                                <td className="py-1 text-right">
                                  {formatCurrency(item.line_total_cents)}
                                </td>
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
      ) : null}

      {!groupByCategory && sub === 'bills' ? (
        /* Bills */
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Bills & Sub Invoices</h3>
            {!showBillForm && !editingBill && (
              <Button size="sm" onClick={() => setShowBillForm(true)}>
                + Log bill
              </Button>
            )}
          </div>

          {(showBillForm || editingBill) && (
            <div className="mb-4">
              <BillForm
                projectId={projectId}
                buckets={buckets}
                initial={editingBill ?? undefined}
                onDone={() => {
                  setShowBillForm(false);
                  setEditingBill(null);
                }}
              />
            </div>
          )}

          {filteredBills.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {focusCategoryName ? `No bills in ${focusCategoryName}.` : 'No bills logged yet.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left font-medium">Vendor</th>
                    <th className="px-3 py-2 text-left font-medium">Date</th>
                    <th className="px-3 py-2 text-left font-medium">Bucket</th>
                    <th className="px-3 py-2 text-left font-medium">Description</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-right font-medium">Subtotal</th>
                    <th className="px-3 py-2 text-right font-medium">GST</th>
                    <th className="px-3 py-2 text-right font-medium">Total</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {filteredBills.map((bill) => (
                    <tr key={bill.id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">
                        <div className="flex items-center gap-1.5">
                          {bill.attachment_storage_path && (
                            <Paperclip className="size-3 shrink-0 text-muted-foreground" />
                          )}
                          {bill.vendor}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{bill.bill_date}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {bill.budget_category_name ? (
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                            {bill.budget_category_name}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{bill.description || '—'}</td>
                      <td className="px-3 py-2 capitalize text-muted-foreground">{bill.status}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {formatCurrency(bill.amount_cents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                        {bill.gst_cents > 0 ? formatCurrency(bill.gst_cents) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-medium tabular-nums">
                        {formatCurrency(bill.amount_cents + bill.gst_cents)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onClick={() => {
                              setEditingBill(bill);
                              setShowBillForm(false);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => handleDeleteBill(bill.id)}
                          >
                            Del
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="border-t px-3 py-2 text-right text-sm">
                <span className="text-muted-foreground">Total billed (subtotal): </span>
                <span className="font-semibold">{formatCurrency(totalBills)}</span>
                {bills.some((b) => b.gst_cents > 0) && (
                  <span className="ml-3 text-muted-foreground">
                    + {formatCurrency(bills.reduce((s, b) => s + b.gst_cents, 0))} GST
                  </span>
                )}
              </div>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
