'use client';

/**
 * Overhead expense entry form. Drop zone at the top — upload a receipt
 * and Gemini/GPT extracts vendor + date + amount + tax + suggests a
 * category. Operator confirms/edits, submits.
 *
 * The OCR call happens on the server via extractOverheadReceiptAction.
 * We stash the uploaded File locally and also ship it with the final
 * submit so the receipt is attached to the expense row.
 */

import { Loader2, Paperclip, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CategoryPickerOption } from '@/lib/db/queries/expense-categories';
import {
  extractOverheadReceiptAction,
  logOverheadExpenseAction,
} from '@/server/actions/overhead-expenses';

type Props = {
  categories: CategoryPickerOption[];
  /** Active GST/HST rate for the tenant (0-1). 0 disables auto-calc. */
  gstRate: number;
  /** Display label for the rate ("GST 5%", "HST 13%"). */
  gstLabel: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dollarsToCents(s: string): number {
  const cleaned = s.replace(/[^\d.-]/g, '');
  const n = Number.parseFloat(cleaned);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function centsToDollars(c: number): string {
  return (c / 100).toFixed(2);
}

/**
 * Shows "{label} = $X.XX" with click-to-apply when the user has entered
 * a total but left tax blank / wrong. Silent when everything lines up.
 */
function TaxHint({
  amount,
  tax,
  gstRate,
  gstLabel,
  onApply,
}: {
  amount: string;
  tax: string;
  gstRate: number;
  gstLabel: string;
  onApply: (v: string) => void;
}) {
  if (gstRate <= 0) return null;
  const amountCents = dollarsToCents(amount);
  if (amountCents <= 0) return null;
  const computed = Math.round(amountCents - amountCents / (1 + gstRate));
  if (computed <= 0) return null;
  const computedStr = centsToDollars(computed);
  const current = dollarsToCents(tax);
  // Match within 1 cent of the computed value — rounding noise on
  // borderline amounts.
  if (Math.abs(current - computed) <= 1 && current > 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Matches {gstLabel} of total ${computedStr}.
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {gstLabel} of total = ${computedStr}.{' '}
      <button
        type="button"
        onClick={() => onApply(computedStr)}
        className="font-medium text-foreground underline-offset-2 hover:underline"
      >
        Use this
      </button>
    </p>
  );
}

export function OverheadExpenseForm({ categories, gstRate, gstLabel }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [parsing, setParsing] = useState(false);

  const [receipt, setReceipt] = useState<File | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [amount, setAmount] = useState('');
  const [tax, setTax] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [expenseDate, setExpenseDate] = useState(todayIso());

  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleReceipt(file: File) {
    setReceipt(file);
    setParsing(true);
    const fd = new FormData();
    fd.append('receipt', file);
    const res = await extractOverheadReceiptAction(fd);
    setParsing(false);
    if (!res.ok) {
      toast.error(`OCR: ${res.error}`);
      return;
    }
    // Only fill fields the user hasn't already touched — don't clobber input.
    if (!vendor && res.fields.vendor) setVendor(res.fields.vendor);
    if (!amount && res.fields.amountCents != null)
      setAmount(centsToDollars(res.fields.amountCents));
    if (!tax && res.fields.taxCents != null) setTax(centsToDollars(res.fields.taxCents));
    if (expenseDate === todayIso() && res.fields.expenseDate)
      setExpenseDate(res.fields.expenseDate);
    if (!description && res.fields.description) setDescription(res.fields.description);
    if (!categoryId && res.fields.suggestedCategoryId)
      setCategoryId(res.fields.suggestedCategoryId);
    toast.success('Receipt scanned — double-check the fields.');
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) handleReceipt(f);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!categoryId) {
      setError('Pick a category.');
      return;
    }
    const amountCents = dollarsToCents(amount);
    if (amountCents === 0) {
      setError('Amount is required.');
      return;
    }

    const fd = new FormData();
    fd.append('category_id', categoryId);
    fd.append('amount_cents', String(amountCents));
    fd.append('tax_cents', String(dollarsToCents(tax)));
    fd.append('vendor', vendor);
    fd.append('description', description);
    fd.append('expense_date', expenseDate);
    if (receipt) fd.append('receipt', receipt);

    startTransition(async () => {
      const res = await logOverheadExpenseAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast.success('Expense logged');
      router.push('/expenses');
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      {/* OCR drop zone */}
      <div className="rounded-lg border border-dashed bg-muted/20 p-4">
        <label className="flex cursor-pointer flex-col items-center gap-2 text-center">
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onPick}
          />
          {receipt ? (
            <div className="flex w-full items-center justify-between gap-3 rounded-md border bg-background px-3 py-2 text-sm">
              <span className="flex items-center gap-2 truncate">
                <Paperclip className="size-4 shrink-0" />
                <span className="truncate">{receipt.name}</span>
              </span>
              {parsing ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Reading…
                </span>
              ) : (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    setReceipt(null);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                  aria-label="Remove receipt"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          ) : (
            <>
              <Paperclip className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">Drop a receipt to auto-fill</span>
              <span className="text-xs text-muted-foreground">
                Photo or PDF. We&apos;ll fill in the fields below — you review before saving.
              </span>
            </>
          )}
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            required
          >
            <option value="">— Pick a category —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id} disabled={c.isParentHeader}>
                {c.label}
                {c.isParentHeader ? ' (sub-accounts below)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="amount">Amount (total)</Label>
          <Input
            id="amount"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tax">{gstLabel} (included in total)</Label>
          <Input
            id="tax"
            inputMode="decimal"
            value={tax}
            onChange={(e) => setTax(e.target.value)}
            placeholder="0.00"
          />
          <TaxHint
            amount={amount}
            tax={tax}
            gstRate={gstRate}
            gstLabel={gstLabel}
            onApply={(v) => setTax(v)}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="date">Date</Label>
          <Input
            id="date"
            type="date"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="vendor">Vendor</Label>
          <Input
            id="vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="e.g. Home Depot"
          />
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What was this for?"
            rows={2}
          />
        </div>
      </div>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || parsing}>
          {pending ? 'Saving…' : 'Log expense'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push('/expenses')}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
