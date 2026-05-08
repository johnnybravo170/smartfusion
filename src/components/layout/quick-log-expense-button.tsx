'use client';

/**
 * "Log expense" button in the top header, sibling to QuickLogTimeButton.
 *
 * Smart intake:
 *   - Drop a receipt (image / PDF) → auto-fires extractReceiptFieldsAction
 *     and pre-fills vendor / amount / date / description / GST number.
 *   - Mode toggle between Project expense (picks project + category) and
 *     Overhead (picks expense category).
 *   - Dropzone works via drag from anywhere OR click-to-pick. Voice
 *     memos not supported on this surface (receipts only).
 */

import { DollarSign, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  type DuplicateExpense,
  DuplicateExpenseDialog,
} from '@/components/features/expenses/duplicate-expense-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  listExpenseCategoryOptionsAction,
  listProjectsWithCategoriesForExpenseAction,
  logExpenseWithReceiptAction,
} from '@/server/actions/expenses';
import { extractReceiptFieldsAction } from '@/server/actions/extract-receipt';
import { logOverheadExpenseAction } from '@/server/actions/overhead-expenses';

type Mode = 'project' | 'overhead';
type ProjectOption = { id: string; name: string; categories: Array<{ id: string; name: string }> };
type CategoryOption = { id: string; label: string; isParentHeader: boolean };

const RECEIPT_ACCEPT = 'image/*,application/pdf';

function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });
}

export function QuickLogExpenseButton() {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1">
          <DollarSign className="size-3.5" />
          <span className="hidden sm:inline">Log Expense</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log expense</DialogTitle>
        </DialogHeader>
        {open ? <ExpenseDialogBody onDone={() => setOpen(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpenseDialogBody({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<Mode>('project');
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loadingLookups, setLoadingLookups] = useState(true);

  const [projectId, setProjectId] = useState('');
  // Project mode: which budget category on the chosen project this expense maps to.
  // Overhead mode: which expense_category (chart-of-accounts node) this overhead expense maps to.
  // Two separate state slots so switching modes doesn't lose the other side.
  const [budgetCategoryId, setBudgetCategoryId] = useState('');
  const [overheadCategoryId, setOverheadCategoryId] = useState('');

  const [receipt, setReceipt] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorGstNumber, setVendorGstNumber] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [duplicate, setDuplicate] = useState<DuplicateExpense | null>(null);
  const [pending, startSaving] = useTransition();
  // Pre-tax / tax breakdown captured from the receipt OCR. Used as the
  // markup base on cost-plus client invoices so we don't mark up GST that
  // the contractor reclaims as an ITC. Cleared if the operator hand-edits
  // the amount.
  const [preTaxCents, setPreTaxCents] = useState<number | null>(null);
  const [taxCents, setTaxCents] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingLookups(true);
      const [projectsRes, categoriesRes] = await Promise.all([
        listProjectsWithCategoriesForExpenseAction(),
        listExpenseCategoryOptionsAction(),
      ]);
      if (cancelled) return;
      if (projectsRes.ok) setProjects(projectsRes.projects);
      if (categoriesRes.ok) setCategories(categoriesRes.options);
      setLoadingLookups(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const projectCategories = projects.find((p) => p.id === projectId)?.categories ?? [];

  async function handleReceipt(file: File | null) {
    setReceipt(file);
    if (!file) return;
    const supported = file.type.startsWith('image/') || file.type === 'application/pdf';
    if (!supported) return;

    setExtracting(true);
    try {
      const fd = new FormData();
      fd.append('receipt', file);
      const res = await extractReceiptFieldsAction(fd);
      if (!res.ok) {
        toast.error(`Could not read receipt: ${res.error}`);
        return;
      }
      // Never silently overwrite values the operator has already typed.
      const fields = res.fields;
      if (fields.amountCents != null && !amount.trim()) {
        setAmount((fields.amountCents / 100).toFixed(2));
        // Breakdown is only valid against this OCR'd amount.
        setPreTaxCents(fields.preTaxAmountCents);
        setTaxCents(fields.taxAmountCents);
      }
      if (fields.vendor && !vendor.trim()) setVendor(fields.vendor);
      if (fields.vendorGstNumber && !vendorGstNumber.trim()) {
        setVendorGstNumber(fields.vendorGstNumber);
      }
      if (fields.expenseDate) setDate(fields.expenseDate);
      if (fields.description && !description.trim()) setDescription(fields.description);
      toast.success('Receipt read — review and save.');
    } finally {
      setExtracting(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) void handleReceipt(file);
  }

  function onDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDraggingOver(true);
  }

  function onDragLeave(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
  }

  function runSave(force: boolean) {
    const amountCents = Math.round(Number.parseFloat(amount) * 100);
    startSaving(async () => {
      const fd = new FormData();
      fd.append('amount_cents', String(amountCents));
      // pre_tax_amount_cents goes to the new column; tax_cents is the
      // pre-existing column the bookkeeping flows already use.
      if (preTaxCents != null) fd.append('pre_tax_amount_cents', String(preTaxCents));
      if (taxCents != null) fd.append('tax_cents', String(taxCents));
      fd.append('expense_date', date);
      if (vendor.trim()) fd.append('vendor', vendor.trim());
      if (vendorGstNumber.trim()) fd.append('vendor_gst_number', vendorGstNumber.trim());
      if (description.trim()) fd.append('description', description.trim());
      if (receipt) fd.append('receipt', receipt);
      if (force) fd.append('force', '1');

      if (mode === 'project') {
        fd.append('project_id', projectId);
        if (budgetCategoryId) fd.append('budget_category_id', budgetCategoryId);
        const res = await logExpenseWithReceiptAction(fd);
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        toast.success('Project expense logged.');
        onDone();
      } else {
        fd.append('category_id', overheadCategoryId);
        const res = await logOverheadExpenseAction(fd);
        if (!res.ok) {
          if ('duplicate' in res) {
            setDuplicate(res.duplicate);
            return;
          }
          toast.error(res.error);
          return;
        }
        toast.success('Overhead expense logged.');
        onDone();
      }
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const amountCents = Math.round(Number.parseFloat(amount) * 100);
    if (!amount.trim() || Number.isNaN(amountCents) || amountCents === 0) {
      toast.error('Enter an amount.');
      return;
    }
    if (!date) {
      toast.error('Enter a date.');
      return;
    }
    if (mode === 'project' && !projectId) {
      toast.error('Pick a project.');
      return;
    }
    if (mode === 'overhead' && !overheadCategoryId) {
      toast.error('Pick a category.');
      return;
    }
    runSave(false);
  }

  const busy = pending || extracting;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Receipt drop zone */}
      <div>
        <Label className="mb-1 block text-xs font-medium text-muted-foreground">
          Receipt (drop or pick — Henry reads it)
        </Label>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          disabled={busy}
          className={cn(
            'flex w-full flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed bg-card px-4 py-5 text-center transition-colors',
            busy && 'cursor-not-allowed opacity-60',
            isDraggingOver
              ? 'border-primary bg-primary/5'
              : 'border-muted-foreground/25 hover:border-muted-foreground/50',
          )}
        >
          {extracting ? (
            <span className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Reading receipt…
            </span>
          ) : receipt ? (
            <>
              <span className="text-sm font-medium">{receipt.name}</span>
              <span className="text-xs text-muted-foreground">Tap to replace</span>
            </>
          ) : (
            <>
              <span className="text-sm font-medium">
                {isDraggingOver ? 'Drop to read' : 'Drop a receipt here'}
              </span>
              <span className="text-xs text-muted-foreground">
                Image or PDF — or type the fields below
              </span>
            </>
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={RECEIPT_ACCEPT}
          hidden
          onChange={(e) => handleReceipt(e.target.files?.[0] ?? null)}
        />
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-1">
        <ModeButton active={mode === 'project'} onClick={() => setMode('project')}>
          Project expense
        </ModeButton>
        <ModeButton active={mode === 'overhead'} onClick={() => setMode('overhead')}>
          Overhead
        </ModeButton>
      </div>

      {/* Mode-specific pickers */}
      {mode === 'project' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label
              htmlFor="exp-project"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Project
            </Label>
            <Select
              value={projectId}
              onValueChange={setProjectId}
              disabled={busy || loadingLookups}
            >
              <SelectTrigger id="exp-project">
                <SelectValue placeholder={loadingLookups ? 'Loading…' : 'Pick a project'} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label
              htmlFor="exp-category"
              className="mb-1 block text-xs font-medium text-muted-foreground"
            >
              Category (optional)
            </Label>
            <Select
              value={budgetCategoryId}
              onValueChange={setBudgetCategoryId}
              disabled={busy || projectCategories.length === 0}
            >
              <SelectTrigger id="exp-category">
                <SelectValue
                  placeholder={projectCategories.length === 0 ? 'None yet' : 'Pick a category'}
                />
              </SelectTrigger>
              <SelectContent>
                {projectCategories.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <div>
          <Label
            htmlFor="exp-category"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Category
          </Label>
          <Select
            value={overheadCategoryId}
            onValueChange={setOverheadCategoryId}
            disabled={busy || loadingLookups}
          >
            <SelectTrigger id="exp-category">
              <SelectValue placeholder={loadingLookups ? 'Loading…' : 'Pick a category'} />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id} disabled={c.isParentHeader}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Common fields */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label
            htmlFor="exp-amount"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Amount (CAD, tax included)
          </Label>
          <Input
            id="exp-amount"
            type="number"
            step="0.01"
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              // Hand-edit invalidates the OCR'd breakdown.
              setPreTaxCents(null);
              setTaxCents(null);
            }}
            placeholder="0.00"
            disabled={busy}
          />
        </div>
        <div>
          <Label
            htmlFor="exp-date"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Date
          </Label>
          <Input
            id="exp-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="sm:col-span-2">
          <Label
            htmlFor="exp-vendor"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Vendor
          </Label>
          <Input
            id="exp-vendor"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Home Depot, Joe's Plumbing, etc."
            disabled={busy}
          />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="exp-gst" className="mb-1 block text-xs font-medium text-muted-foreground">
            Vendor GST / HST # (optional)
          </Label>
          <Input
            id="exp-gst"
            value={vendorGstNumber}
            onChange={(e) => setVendorGstNumber(e.target.value)}
            placeholder="123456789 RT0001"
            disabled={busy}
          />
        </div>
        <div className="sm:col-span-2">
          <Label
            htmlFor="exp-desc"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            Description
          </Label>
          <Textarea
            id="exp-desc"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Lumber and fasteners, lunch for crew, monthly software…"
            disabled={busy}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {pending ? (
            <>
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            'Log expense'
          )}
        </Button>
      </div>

      <DuplicateExpenseDialog
        duplicate={duplicate}
        onClose={() => setDuplicate(null)}
        onForceSave={() => {
          setDuplicate(null);
          runSave(true);
        }}
        busy={busy}
      />
    </form>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}
