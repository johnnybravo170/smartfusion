'use client';

/**
 * Unified project Costs surface — post-unification replacement for the
 * legacy Bills + Expenses subtabs.
 *
 * One table renders receipts (entered + implicitly paid) alongside
 * vendor bills (with their own paid / unpaid lifecycle), discriminated
 * by a status badge:
 *
 *   Paid receipt        — emerald, source=receipt
 *   Vendor bill • Unpaid — amber,   source=vendor_bill, status=pending|approved
 *   Vendor bill • Paid   — emerald, source=vendor_bill, status=paid
 *
 * A filter chip row (All / Unpaid / Paid) drives a `?costs=` URL param
 * so deep-links survive a refresh.
 *
 * "+ Add cost" opens a tiny gate dialog: "Did you pay this already?"
 *   - Yes → receipt form (current ExpenseForm flow)
 *   - No  → vendor bill form (current BillForm flow)
 *
 * The two forms keep their existing fields and validation; only the
 * entry point is unified. Mark-as-paid is exposed inline on unpaid
 * vendor bill rows and flips through `markBillPaidAction`, which
 * mirrors the bank-confirm path.
 */

import { Paperclip } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { ReceiptPreviewButton } from '@/components/features/expenses/receipt-preview-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ProjectBillRow } from '@/lib/db/queries/project-bills';
import { formatCurrency } from '@/lib/pricing/calculator';
import { projectCostStatusTone, statusToneClass } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import {
  deleteExpenseAction,
  logExpenseWithReceiptAction,
  updateExpenseAction,
} from '@/server/actions/expenses';
import {
  deleteBillAction,
  markBillPaidAction,
  upsertBillWithAttachmentAction,
} from '@/server/actions/project-cost-control';

// ─── Shared types ────────────────────────────────────────────────────────────

export type BillItem = ProjectBillRow & {
  attachment_signed_url: string | null;
  attachment_mime_hint: 'image' | 'pdf' | null;
};

export type ExpenseItem = {
  id: string;
  expense_date: string;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  budget_category_id: string | null;
  cost_line_id: string | null;
  worker_profile_id: string | null;
  worker_name: string | null;
  receipt_url: string | null;
  receipt_mime_hint: 'image' | 'pdf' | null;
};

type Category = {
  id: string;
  name: string;
  cost_lines: Array<{ id: string; label: string }>;
};

type FilterKey = 'all' | 'unpaid' | 'paid';

type CostStatusKey = keyof typeof projectCostStatusTone; // 'paid_receipt' | 'bill_unpaid' | 'bill_paid'

type UnifiedRow =
  | {
      kind: 'receipt';
      id: string;
      cost_date: string;
      vendor: string | null;
      description: string | null;
      budget_category_id: string | null;
      budget_category_name: string | null;
      status: 'paid_receipt';
      subtotal_cents: number;
      gst_cents: number;
      total_cents: number;
      attachment_url: string | null;
      attachment_mime_hint: 'image' | 'pdf' | null;
      source: ExpenseItem;
    }
  | {
      kind: 'bill';
      id: string;
      cost_date: string;
      vendor: string | null;
      description: string | null;
      budget_category_id: string | null;
      budget_category_name: string | null;
      status: 'bill_unpaid' | 'bill_paid';
      subtotal_cents: number;
      gst_cents: number;
      total_cents: number;
      attachment_url: string | null;
      attachment_mime_hint: 'image' | 'pdf' | null;
      source: BillItem;
    };

function displayToCents(val: string) {
  return Math.round(parseFloat(val || '0') * 100);
}

const STATUS_LABEL: Record<CostStatusKey, string> = {
  paid_receipt: 'Paid receipt',
  bill_unpaid: 'Vendor bill • Unpaid',
  bill_paid: 'Vendor bill • Paid',
};

function CostStatusBadge({ status }: { status: CostStatusKey }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        statusToneClass[projectCostStatusTone[status]],
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─── Add-cost gate (Did you pay this?) ───────────────────────────────────────

function AddCostGate({ onChoose }: { onChoose: (kind: 'receipt' | 'bill') => void }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
      <p className="text-sm font-medium">Did you pay this already?</p>
      <p className="text-xs text-muted-foreground">
        Receipts log money already spent. Vendor bills track money owed (sub invoices, suppliers on
        Net 30, etc.) — you can mark them paid later.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onChoose('receipt')}>
          Yes, this is a receipt
        </Button>
        <Button size="sm" variant="outline" onClick={() => onChoose('bill')}>
          No, it&apos;s a vendor bill
        </Button>
      </div>
    </div>
  );
}

// ─── Receipt (expense) form ──────────────────────────────────────────────────

function ReceiptForm({
  projectId,
  categories,
  onDone,
}: {
  projectId: string;
  categories: Category[];
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountRaw, setAmountRaw] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [costLineId, setCostLineId] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const fd = new FormData();
      fd.set('project_id', projectId);
      fd.set('expense_date', date);
      fd.set('amount_cents', String(displayToCents(amountRaw)));
      fd.set('vendor', vendor);
      fd.set('description', description);
      fd.set('budget_category_id', categoryId);
      if (costLineId) fd.set('cost_line_id', costLineId);
      if (receipt) fd.set('receipt', receipt);
      const res = await logExpenseWithReceiptAction(fd);
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        New receipt · paid
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <Label htmlFor="receipt-date">Date</Label>
          <Input
            id="receipt-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div>
          <Label htmlFor="receipt-amount">Amount ($)</Label>
          <Input
            id="receipt-amount"
            type="number"
            step="0.01"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
            placeholder="0.00"
            required
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Use a negative number for credits/returns.
          </p>
        </div>
        <div>
          <Label htmlFor="receipt-vendor">Vendor</Label>
          <Input
            id="receipt-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {categories.length > 0 && (
          <div>
            <Label htmlFor="receipt-category">Category</Label>
            <select
              id="receipt-category"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setCostLineId('');
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">— none —</option>
              {categories.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {(() => {
          const lines = categories.find((b) => b.id === categoryId)?.cost_lines ?? [];
          if (!categoryId || lines.length === 0) return null;
          return (
            <div>
              <Label htmlFor="receipt-line">Line item</Label>
              <select
                id="receipt-line"
                value={costLineId}
                onChange={(e) => setCostLineId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">— category only —</option>
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
          <Label htmlFor="receipt-desc">Description</Label>
          <Input
            id="receipt-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="sm:col-span-4">
          <Label htmlFor="receipt-file">Receipt</Label>
          <Input
            id="receipt-file"
            type="file"
            accept="image/*,application/pdf"
            onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
          />
          {receipt && (
            <p className="mt-1 text-xs text-muted-foreground">
              {receipt.name} · {(receipt.size / 1024).toFixed(0)} KB
            </p>
          )}
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Log receipt'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Bill form ───────────────────────────────────────────────────────────────

const GST_RATE = 0.05;

function BillForm({
  projectId,
  categories,
  initial,
  onDone,
}: {
  projectId: string;
  categories: Category[];
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
  const [categoryId, setCategoryId] = useState(initial?.budget_category_id ?? '');
  const [costLineId, setCostLineId] = useState(initial?.cost_line_id ?? '');
  const [costCode, setCostCode] = useState(initial?.cost_code ?? '');
  const [vendorGstNumber, setVendorGstNumber] = useState(initial?.vendor_gst_number ?? '');
  const [attachmentFile, setAttachmentFile] = useState<File | null>(null);
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
      fd.set('budget_category_id', categoryId);
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
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {initial ? 'Edit vendor bill' : 'New vendor bill · unpaid'}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <Label htmlFor="bill-vendor">Vendor</Label>
          <Input
            id="bill-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Vendor name"
            required
          />
        </div>
        <div>
          <Label htmlFor="bill-date">Date</Label>
          <Input
            id="bill-date"
            type="date"
            value={billDate}
            onChange={(e) => setBillDate(e.target.value)}
            required
          />
        </div>
        {categories.length > 0 && (
          <div>
            <Label htmlFor="bill-category">Category</Label>
            <select
              id="bill-category"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setCostLineId('');
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">— none —</option>
              {categories.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {(() => {
          const lines = categories.find((b) => b.id === categoryId)?.cost_lines ?? [];
          if (!categoryId || lines.length === 0) return null;
          return (
            <div>
              <Label htmlFor="bill-line">Line item (optional)</Label>
              <select
                id="bill-line"
                value={costLineId}
                onChange={(e) => setCostLineId(e.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">— category only —</option>
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
          <Label htmlFor="bill-desc">Description</Label>
          <Input
            id="bill-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div>
          <Label htmlFor="bill-code">Cost Code</Label>
          <Input
            id="bill-code"
            value={costCode}
            onChange={(e) => setCostCode(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="bill-vendor-gst">Vendor GST # (optional)</Label>
          <Input
            id="bill-vendor-gst"
            value={vendorGstNumber}
            onChange={(e) => setVendorGstNumber(e.target.value)}
            placeholder="e.g. 123456789 RT0001"
          />
        </div>
      </div>

      <div className="space-y-2 rounded-md border bg-background p-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="bill-subtotal">Subtotal ($)</Label>
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
            <Label htmlFor="bill-gst">
              GST ($) <span className="ml-1 font-normal text-muted-foreground">5%</span>
            </Label>
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
          {pending ? 'Saving…' : initial ? 'Update bill' : 'Log bill'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Edit receipt dialog ─────────────────────────────────────────────────────

function EditReceiptDialog({
  expense,
  categories,
  onClose,
}: {
  expense: ExpenseItem;
  categories: Category[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [amountRaw, setAmountRaw] = useState(() => (expense.amount_cents / 100).toFixed(2));
  const [date, setDate] = useState(expense.expense_date);
  const [vendor, setVendor] = useState(expense.vendor ?? '');
  const [description, setDescription] = useState(expense.description ?? '');
  const [categoryId, setCategoryId] = useState(expense.budget_category_id ?? '');
  const [costLineId, setCostLineId] = useState(expense.cost_line_id ?? '');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseFloat(amountRaw);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError('Amount must be non-zero.');
      return;
    }
    startTransition(async () => {
      const res = await updateExpenseAction({
        id: expense.id,
        expense_date: date,
        amount_cents: Math.round(parsed * 100),
        vendor: vendor || null,
        description: description || null,
        budget_category_id: categoryId || null,
        cost_line_id: costLineId || null,
      });
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      toast.success('Receipt updated.');
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit receipt</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-receipt-date">Date</Label>
              <Input
                id="edit-receipt-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="edit-receipt-amt">Amount ($)</Label>
              <Input
                id="edit-receipt-amt"
                type="number"
                step="0.01"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                required
                disabled={pending}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Negative = credit/return.</p>
            </div>
          </div>
          {categories.length > 0 ? (
            <div>
              <Label htmlFor="edit-receipt-category">Category</Label>
              <select
                id="edit-receipt-category"
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setCostLineId('');
                }}
                disabled={pending}
                className="mt-1 block w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">— None —</option>
                {categories.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {(() => {
            const lines = categories.find((b) => b.id === categoryId)?.cost_lines ?? [];
            if (!categoryId || lines.length === 0) return null;
            return (
              <div>
                <Label htmlFor="edit-receipt-line">Line item</Label>
                <select
                  id="edit-receipt-line"
                  value={costLineId}
                  onChange={(e) => setCostLineId(e.target.value)}
                  disabled={pending}
                  className="mt-1 block w-full rounded-md border px-3 py-2 text-sm"
                >
                  <option value="">— category only —</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
            );
          })()}
          <div>
            <Label htmlFor="edit-receipt-vendor">Vendor</Label>
            <Input
              id="edit-receipt-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="edit-receipt-desc">Description</Label>
            <Input
              id="edit-receipt-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={pending}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Filter chips ────────────────────────────────────────────────────────────

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'unpaid', label: 'Unpaid' },
  { key: 'paid', label: 'Paid' },
];

function FilterChips({
  current,
  counts,
  hrefForFilter,
}: {
  current: FilterKey;
  counts: Record<FilterKey, number>;
  hrefForFilter: (key: FilterKey) => string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {FILTERS.map((f) => (
        <a
          key={f.key}
          href={hrefForFilter(f.key)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
            current === f.key
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-muted bg-card text-muted-foreground hover:bg-muted/50',
          )}
        >
          {f.label}
          <Badge variant="secondary" className="h-4 min-w-[16px] px-1 text-[10px] leading-none">
            {counts[f.key]}
          </Badge>
        </a>
      ))}
    </div>
  );
}

// ─── Main section ────────────────────────────────────────────────────────────

export function ProjectCostsSection({
  projectId,
  bills,
  expenses,
  categories,
}: {
  projectId: string;
  bills: BillItem[];
  expenses: ExpenseItem[];
  categories: Category[];
}) {
  const searchParams = useSearchParams();
  const filter: FilterKey = (() => {
    const raw = searchParams?.get('costs');
    if (raw === 'unpaid' || raw === 'paid') return raw;
    return 'all';
  })();

  const [showGate, setShowGate] = useState(false);
  const [adding, setAdding] = useState<'receipt' | 'bill' | null>(null);
  const [editingBill, setEditingBill] = useState<BillItem | null>(null);
  const [editingReceipt, setEditingReceipt] = useState<ExpenseItem | null>(null);
  const [, startTransition] = useTransition();

  // Build the unified row stream.
  const rows: UnifiedRow[] = [];
  for (const e of expenses) {
    rows.push({
      kind: 'receipt',
      id: e.id,
      cost_date: e.expense_date,
      vendor: e.vendor,
      description: e.description,
      budget_category_id: e.budget_category_id,
      budget_category_name: null,
      status: 'paid_receipt',
      // Receipts store gross in amount_cents; we don't surface a GST split
      // on the row since the OCR field isn't shown here pre-unification.
      subtotal_cents: e.amount_cents,
      gst_cents: 0,
      total_cents: e.amount_cents,
      attachment_url: e.receipt_url,
      attachment_mime_hint: e.receipt_mime_hint,
      source: e,
    });
  }
  for (const b of bills) {
    rows.push({
      kind: 'bill',
      id: b.id,
      cost_date: b.bill_date,
      vendor: b.vendor,
      description: b.description,
      budget_category_id: b.budget_category_id,
      budget_category_name: b.budget_category_name,
      status: b.status === 'paid' ? 'bill_paid' : 'bill_unpaid',
      // Bills store pre-GST in amount_cents (carries forward the legacy
      // project_bills semantics — preserved through the unification PR).
      subtotal_cents: b.amount_cents,
      gst_cents: b.gst_cents,
      total_cents: b.amount_cents + b.gst_cents,
      attachment_url: b.attachment_signed_url,
      attachment_mime_hint: b.attachment_mime_hint,
      source: b,
    });
  }
  rows.sort((a, b) => b.cost_date.localeCompare(a.cost_date));

  // Per-filter counts.
  const counts: Record<FilterKey, number> = {
    all: rows.length,
    unpaid: rows.filter((r) => r.status === 'bill_unpaid').length,
    paid: rows.filter((r) => r.status !== 'bill_unpaid').length,
  };

  const filtered =
    filter === 'unpaid'
      ? rows.filter((r) => r.status === 'bill_unpaid')
      : filter === 'paid'
        ? rows.filter((r) => r.status !== 'bill_unpaid')
        : rows;

  function hrefForFilter(key: FilterKey): string {
    const params = new URLSearchParams(searchParams?.toString());
    if (key === 'all') params.delete('costs');
    else params.set('costs', key);
    const qs = params.toString();
    return qs ? `?${qs}` : '?';
  }

  function handleDeleteBill(id: string) {
    if (!confirm('Delete this vendor bill?')) return;
    startTransition(async () => {
      const res = await deleteBillAction(id, projectId);
      if (!res.ok) toast.error(res.error);
    });
  }

  function handleDeleteReceipt(id: string) {
    if (!confirm('Delete this receipt?')) return;
    startTransition(async () => {
      const res = await deleteExpenseAction(id);
      if (!res.ok) toast.error(res.error);
    });
  }

  function handleMarkPaid(id: string) {
    startTransition(async () => {
      const res = await markBillPaidAction(id, projectId);
      if (!res.ok) toast.error(res.error);
      else toast.success('Bill marked paid.');
    });
  }

  const totalSubtotal = filtered.reduce((s, r) => s + r.subtotal_cents, 0);
  const totalGst = filtered.reduce((s, r) => s + r.gst_cents, 0);
  const totalGross = filtered.reduce((s, r) => s + r.total_cents, 0);

  const showingForm =
    showGate || adding !== null || editingBill !== null || editingReceipt !== null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FilterChips current={filter} counts={counts} hrefForFilter={hrefForFilter} />
        {!showingForm && (
          <Button size="sm" onClick={() => setShowGate(true)}>
            + Add cost
          </Button>
        )}
      </div>

      {showGate && !adding && (
        <AddCostGate
          onChoose={(k) => {
            setAdding(k);
            setShowGate(false);
          }}
        />
      )}

      {adding === 'receipt' && (
        <ReceiptForm projectId={projectId} categories={categories} onDone={() => setAdding(null)} />
      )}

      {adding === 'bill' && (
        <BillForm projectId={projectId} categories={categories} onDone={() => setAdding(null)} />
      )}

      {editingBill && (
        <BillForm
          projectId={projectId}
          categories={categories}
          initial={editingBill}
          onDone={() => setEditingBill(null)}
        />
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No costs logged yet. Add a receipt or a vendor bill above.
        </p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing here under this filter. Try{' '}
          <a href={hrefForFilter('all')} className="text-primary hover:underline">
            All costs
          </a>
          .
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Vendor</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Category</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Subtotal</th>
                <th className="px-3 py-2 text-right font-medium">GST</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={`${r.kind}:${r.id}`} className="border-b last:border-0">
                  <td className="px-3 py-2 text-muted-foreground tabular-nums">{r.cost_date}</td>
                  <td className="px-3 py-2 font-medium">
                    <div className="flex items-center gap-1.5">
                      {r.attachment_url && (
                        <ReceiptPreviewButton
                          url={r.attachment_url}
                          mimeHint={r.attachment_mime_hint}
                          vendor={r.vendor}
                        />
                      )}
                      {r.kind === 'bill' || r.vendor ? (
                        <button
                          type="button"
                          onClick={() => {
                            if (r.kind === 'bill') setEditingBill(r.source);
                            else setEditingReceipt(r.source);
                          }}
                          className="text-left text-primary hover:underline"
                        >
                          {r.vendor ?? 'Receipt'}
                        </button>
                      ) : (
                        '—'
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <CostStatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {r.budget_category_name ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider">
                        {r.budget_category_name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{r.description || '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(r.subtotal_cents)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {r.gst_cents > 0 ? formatCurrency(r.gst_cents) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatCurrency(r.total_cents)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      {r.status === 'bill_unpaid' ? (
                        <Button size="xs" variant="outline" onClick={() => handleMarkPaid(r.id)}>
                          Mark paid
                        </Button>
                      ) : null}
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => {
                          if (r.kind === 'bill') setEditingBill(r.source);
                          else setEditingReceipt(r.source);
                        }}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          if (r.kind === 'bill') handleDeleteBill(r.id);
                          else handleDeleteReceipt(r.id);
                        }}
                      >
                        Del
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t px-3 py-2 text-right text-xs text-muted-foreground">
            {filtered.length} row{filtered.length === 1 ? '' : 's'} ·{' '}
            <span className="font-semibold text-foreground">{formatCurrency(totalGross)}</span>{' '}
            total{' '}
            {totalGst > 0 ? (
              <span>
                ({formatCurrency(totalSubtotal)} subtotal + {formatCurrency(totalGst)} GST)
              </span>
            ) : null}
          </div>
        </div>
      )}

      {editingReceipt ? (
        <EditReceiptDialog
          key={editingReceipt.id}
          expense={editingReceipt}
          categories={categories}
          onClose={() => setEditingReceipt(null)}
        />
      ) : null}
    </section>
  );
}
