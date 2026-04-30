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
import {
  type DuplicateExpense,
  DuplicateExpenseDialog,
} from '@/components/features/expenses/duplicate-expense-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { CategoryPickerOption } from '@/lib/db/queries/expense-categories';
import { createExpenseCategoryAction } from '@/server/actions/expense-categories';
import {
  extractOverheadReceiptAction,
  logOverheadExpenseAction,
  updateOverheadExpenseAction,
} from '@/server/actions/overhead-expenses';
import { getVendorSuggestionAction } from '@/server/actions/vendor-intelligence';

const ADD_NEW_SENTINEL = '__add_new__';

/** Initial values for editing an existing expense. */
export type OverheadExpenseInitialValues = {
  id: string;
  categoryId: string | null;
  amountCents: number;
  taxCents: number;
  vendor: string | null;
  vendorGstNumber: string | null;
  description: string | null;
  expenseDate: string;
  existingReceiptPath: string | null;
  existingReceiptUrl: string | null;
};

type Props = {
  categories: CategoryPickerOption[];
  /** Active GST/HST rate for the tenant (0-1). 0 disables auto-calc. */
  gstRate: number;
  /** Display label for the rate ("GST 5%", "HST 13%"). */
  gstLabel: string;
  /** When set, the form is in edit mode and pre-fills these values. */
  initialValues?: OverheadExpenseInitialValues;
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

export function OverheadExpenseForm({
  categories: initialCategories,
  gstRate,
  gstLabel,
  initialValues,
}: Props) {
  const router = useRouter();
  const isEdit = !!initialValues;
  const [pending, startTransition] = useTransition();
  const [parsing, setParsing] = useState(false);

  // Local copy so inline "Add new category" can optimistically extend
  // the list without a server round-trip to re-render the picker.
  const [categories, setCategories] = useState(initialCategories);
  const [addCategoryOpen, setAddCategoryOpen] = useState(false);

  const [receipt, setReceipt] = useState<File | null>(null);
  // When editing: existingReceiptUrl is the signed URL for the already-
  // attached receipt. removeExistingReceipt lets the user clear it.
  const [removeExistingReceipt, setRemoveExistingReceipt] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateExpense | null>(null);
  const [categoryId, setCategoryId] = useState(initialValues?.categoryId ?? '');
  const [amount, setAmount] = useState(
    initialValues ? centsToDollars(initialValues.amountCents) : '',
  );
  const [tax, setTax] = useState(
    initialValues && initialValues.taxCents > 0 ? centsToDollars(initialValues.taxCents) : '',
  );
  const [vendor, setVendor] = useState(initialValues?.vendor ?? '');
  const [vendorGstNumber, setVendorGstNumber] = useState(initialValues?.vendorGstNumber ?? '');
  const [vendorSuggestion, setVendorSuggestion] = useState<{
    category_id: string;
    category_label: string;
    confidence: number;
    sample_size: number;
  } | null>(null);
  const [description, setDescription] = useState(initialValues?.description ?? '');
  const [expenseDate, setExpenseDate] = useState(initialValues?.expenseDate ?? todayIso());

  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleCategoryChange(value: string) {
    if (value === ADD_NEW_SENTINEL) {
      setAddCategoryOpen(true);
      return;
    }
    setCategoryId(value);
  }

  function onCategoryCreated(created: { id: string; label: string; parent_id: string | null }) {
    // Splice the new category into the picker list at a plausible spot:
    // parents go at the end of the top level; children go right after
    // their parent. Keeps the UI coherent without a full refetch.
    setCategories((prev) => {
      const next = [...prev];
      if (created.parent_id) {
        const parentIdx = next.findIndex((c) => c.id === created.parent_id);
        const insertAt =
          parentIdx >= 0
            ? next.findIndex((c, i) => i > parentIdx && c.parent_id !== created.parent_id)
            : -1;
        const idx = insertAt === -1 ? next.length : insertAt;
        next.splice(idx, 0, {
          id: created.id,
          label: created.label,
          isParentHeader: false,
          parent_id: created.parent_id,
        });
      } else {
        next.push({
          id: created.id,
          label: created.label,
          isParentHeader: false,
          parent_id: null,
        });
      }
      return next;
    });
    setCategoryId(created.id);
    setAddCategoryOpen(false);
    // Background refresh so the server-side list + settings page sync.
    router.refresh();
  }

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
    if (!vendorGstNumber && res.fields.vendorGstNumber)
      setVendorGstNumber(res.fields.vendorGstNumber);
    if (!amount && res.fields.amountCents != null)
      setAmount(centsToDollars(res.fields.amountCents));
    if (!tax && res.fields.taxCents != null) setTax(centsToDollars(res.fields.taxCents));
    if (expenseDate === todayIso() && res.fields.expenseDate)
      setExpenseDate(res.fields.expenseDate);
    if (!description && res.fields.description) setDescription(res.fields.description);
    if (!categoryId && res.fields.suggestedCategoryId)
      setCategoryId(res.fields.suggestedCategoryId);

    // Kick off a vendor-history lookup once we have a name. The OCR
    // model already sees vendor hints in its prompt; this second lookup
    // just surfaces the hint inline so the operator sees WHY a category
    // was auto-filled (and can override if wrong).
    const vendorToCheck = res.fields.vendor ?? vendor;
    if (vendorToCheck?.trim()) {
      const v = await getVendorSuggestionAction({ vendor: vendorToCheck });
      if (v.ok) setVendorSuggestion(v.suggestion);
    }
    toast.success('Receipt scanned — double-check the fields.');
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) handleReceipt(f);
  }

  function buildFormData(force: boolean): FormData {
    const fd = new FormData();
    if (isEdit && initialValues) fd.append('id', initialValues.id);
    fd.append('category_id', categoryId);
    fd.append('amount_cents', String(dollarsToCents(amount)));
    fd.append('tax_cents', String(dollarsToCents(tax)));
    fd.append('vendor', vendor);
    fd.append('vendor_gst_number', vendorGstNumber);
    fd.append('description', description);
    fd.append('expense_date', expenseDate);
    if (receipt) fd.append('receipt', receipt);
    if (isEdit && removeExistingReceipt && !receipt) fd.append('remove_receipt', '1');
    if (force) fd.append('force', '1');
    return fd;
  }

  function runSave(force: boolean) {
    startTransition(async () => {
      const fd = buildFormData(force);
      const res = isEdit
        ? await updateOverheadExpenseAction(fd)
        : await logOverheadExpenseAction(fd);
      if (res.ok) {
        toast.success(isEdit ? 'Expense updated' : 'Expense logged');
        router.push('/expenses');
        return;
      }
      if ('duplicate' in res) {
        setDuplicate(res.duplicate);
        return;
      }
      setError(res.error);
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!categoryId) {
      setError('Pick a category.');
      return;
    }
    if (dollarsToCents(amount) === 0) {
      setError('Amount is required.');
      return;
    }
    runSave(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      {/* Existing receipt (edit mode) — show a link + keep/replace/remove controls. */}
      {isEdit && initialValues?.existingReceiptPath && !receipt && !removeExistingReceipt ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/20 px-4 py-3 text-sm">
          <Paperclip className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {initialValues.existingReceiptUrl ? (
              <a
                href={initialValues.existingReceiptUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium hover:underline"
              >
                View current receipt
              </a>
            ) : (
              <span className="text-muted-foreground">Receipt attached</span>
            )}
          </span>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Replace
          </button>
          <button
            type="button"
            onClick={() => setRemoveExistingReceipt(true)}
            className="text-xs text-muted-foreground hover:text-red-600"
          >
            Remove
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            onChange={onPick}
          />
        </div>
      ) : null}

      {/* OCR drop zone — shown when no existing receipt, or in edit mode when the user cleared it. */}
      {!(isEdit && initialValues?.existingReceiptPath && !receipt && !removeExistingReceipt) ? (
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
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            value={categoryId}
            onChange={(e) => handleCategoryChange(e.target.value)}
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
            <option disabled>──────────</option>
            <option value={ADD_NEW_SENTINEL}>+ Add new category…</option>
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
            onBlur={async () => {
              const v = vendor.trim();
              if (!v) {
                setVendorSuggestion(null);
                return;
              }
              const res = await getVendorSuggestionAction({ vendor: v });
              if (res.ok) setVendorSuggestion(res.suggestion);
            }}
            placeholder="e.g. Home Depot"
          />
          {vendorSuggestion && vendorSuggestion.category_id !== categoryId ? (
            <p className="text-xs text-muted-foreground">
              Past {vendorSuggestion.sample_size} entries from &ldquo;{vendor.trim()}&rdquo; used{' '}
              <span className="font-medium text-foreground">{vendorSuggestion.category_label}</span>
              .{' '}
              <button
                type="button"
                onClick={() => setCategoryId(vendorSuggestion.category_id)}
                className="font-medium text-foreground underline-offset-2 hover:underline"
              >
                Use this
              </button>
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <Label htmlFor="vendor-bn">
            Vendor GST/HST number{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="vendor-bn"
            value={vendorGstNumber}
            onChange={(e) => setVendorGstNumber(e.target.value)}
            placeholder="e.g. 123456789 RT0001"
          />
          <p className="text-xs text-muted-foreground">
            CRA requires the vendor&apos;s BN on invoices over $30 to claim the Input Tax Credit.
            Usually auto-filled from the receipt.
          </p>
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
          {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Log expense'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.push('/expenses')}>
          Cancel
        </Button>
      </div>

      <AddCategoryDialog
        open={addCategoryOpen}
        onOpenChange={setAddCategoryOpen}
        parentOptions={categories.filter((c) => c.parent_id === null)}
        onCreated={onCategoryCreated}
      />

      <DuplicateExpenseDialog
        duplicate={duplicate}
        onClose={() => setDuplicate(null)}
        onForceSave={() => {
          setDuplicate(null);
          runSave(true);
        }}
        busy={pending}
      />
    </form>
  );
}

function AddCategoryDialog({
  open,
  onOpenChange,
  parentOptions,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  parentOptions: CategoryPickerOption[];
  onCreated: (created: { id: string; label: string; parent_id: string | null }) => void;
}) {
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function reset() {
    setName('');
    setParentId('');
    setError(null);
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Name is required.');
      return;
    }
    startTransition(async () => {
      const res = await createExpenseCategoryAction({
        name: trimmed,
        parent_id: parentId || null,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const parent = parentId ? parentOptions.find((p) => p.id === parentId) : null;
      onCreated({
        id: res.id,
        label: parent ? `${parent.label} › ${trimmed}` : trimmed,
        parent_id: parentId || null,
      });
      reset();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add category</DialogTitle>
          <DialogDescription>
            Create a new expense category. You can also nest it under an existing one (e.g.
            &ldquo;Vehicles &rsaquo; Truck 2&rdquo;).
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-cat-name">Name</Label>
            <Input
              id="new-cat-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Parking"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-cat-parent">Parent (optional)</Label>
            <select
              id="new-cat-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— None (top-level) —</option>
              {parentOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !name.trim()}>
            {pending ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
