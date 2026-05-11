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

import { AlertCircle, DollarSign, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  type DuplicateExpense,
  DuplicateExpenseDialog,
} from '@/components/features/expenses/duplicate-expense-dialog';
import {
  ExpenseTaxSplitChip,
  type TaxSplitMode,
} from '@/components/features/expenses/expense-tax-split-chip';
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
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { splitTotalByRate } from '@/lib/expenses/tax-split';
import { compressReceiptIfImage, isTimeoutError, withTimeout } from '@/lib/storage/resize-image';
import { cn } from '@/lib/utils';
import {
  listExpenseCategoryOptionsAction,
  listProjectsWithCategoriesForExpenseAction,
  logExpenseWithReceiptAction,
} from '@/server/actions/expenses';
import { extractReceiptFieldsAction } from '@/server/actions/extract-receipt';
import { logOverheadExpenseAction } from '@/server/actions/overhead-expenses';

/** Cap how long we wait for the OCR round-trip before giving the operator
 *  back control — at 30s on poor signal they deserve a retry affordance,
 *  not an open-ended spinner. */
const OCR_TIMEOUT_MS = 30_000;

type Mode = 'project' | 'overhead';
type ProjectOption = {
  id: string;
  name: string;
  is_cost_plus: boolean;
  categories: Array<{ id: string; name: string }>;
};
type CategoryOption = { id: string; label: string; isParentHeader: boolean };

const RECEIPT_ACCEPT = 'image/*,application/pdf';

function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

type Props = {
  /** Tenant's effective GST/HST rate (decimal, e.g. 0.13). Drives the
   *  auto-split chip on cost-plus projects + always on overhead. */
  tenantTaxRate: number;
};

export function QuickLogExpenseButton({ tenantTaxRate }: Props) {
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
        {open ? (
          <ExpenseDialogBody onDone={() => setOpen(false)} tenantTaxRate={tenantTaxRate} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpenseDialogBody({
  onDone,
  tenantTaxRate,
}: {
  onDone: () => void;
  tenantTaxRate: number;
}) {
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
  // Persistent OCR error rendered inline next to the dropzone, with a
  // Retry button — survives toast dismissal so a contractor on weak
  // signal can't miss it after switching apps and back.
  const [extractError, setExtractError] = useState<string | null>(null);
  // Track whether the most recently-applied category came from Henry's
  // OCR suggestion. Drives a "Suggested by Henry" badge so the user can
  // tell the auto-fill apart from their own pick.
  const [suggestedFromOcr, setSuggestedFromOcr] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Closure-stable references to the loaded lookups + the load promise.
  // The OCR call awaits the promise before reading the refs so a fast
  // user (dialog open → snap → upload in <200ms) can't race past the
  // lookups fetch and ship an empty candidate list.
  const lookupsLoadPromiseRef = useRef<Promise<void> | null>(null);
  const categoriesRef = useRef<CategoryOption[]>([]);
  const projectsRef = useRef<ProjectOption[]>([]);

  const tenantTz = useTenantTimezone();
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorGstNumber, setVendorGstNumber] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(() => todayInTz(tenantTz));
  const [duplicate, setDuplicate] = useState<DuplicateExpense | null>(null);
  const [pending, startSaving] = useTransition();
  // Pre-tax / tax breakdown drives the cost-plus markup base. Three sources
  // tracked via splitMode: 'ocr' (from receipt), 'auto' (derived via tenant
  // tax rate from the Total field on blur), 'manual' (operator overrode).
  // For overhead, the breakdown is bookkeeping only — no markup — but the
  // chip still shows so the operator can correct out-of-province receipts.
  const [preTaxCents, setPreTaxCents] = useState<number | null>(null);
  const [taxCents, setTaxCents] = useState<number | null>(null);
  const [splitMode, setSplitMode] = useState<TaxSplitMode>('auto');

  const selectedProject = projects.find((p) => p.id === projectId) ?? null;
  // Project mode: only show the chip on cost-plus projects (where it
  // matters for billing). Overhead mode: always show — it's GST data
  // for bookkeeping regardless of any project-level flag. Skip when the
  // tenant has no tax rate configured (legacy shape) — splitting at 0%
  // is a no-op that just clutters the form.
  const showTaxSplit =
    tenantTaxRate > 0 &&
    (mode === 'overhead' || (mode === 'project' && Boolean(selectedProject?.is_cost_plus)));

  /** Recompute the breakdown from the current Total at the tenant rate.
   *  Called when context changes (mode/project switch) and we want the
   *  chip to reflect the current state without a Total blur. Skips if
   *  in 'manual' mode (operator override is sticky). */
  function refreshAutoSplit() {
    if (splitMode === 'manual') return;
    const cents = Math.round(Number.parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      setPreTaxCents(null);
      setTaxCents(null);
      return;
    }
    const split = splitTotalByRate(cents, tenantTaxRate);
    setPreTaxCents(split.preTaxCents);
    setTaxCents(split.taxCents);
    setSplitMode('auto');
  }

  useEffect(() => {
    let cancelled = false;
    setLoadingLookups(true);
    const promise = (async () => {
      const [projectsRes, categoriesRes] = await Promise.all([
        listProjectsWithCategoriesForExpenseAction(),
        listExpenseCategoryOptionsAction(),
      ]);
      if (cancelled) return;
      if (projectsRes.ok) {
        setProjects(projectsRes.projects);
        projectsRef.current = projectsRes.projects;
      }
      if (categoriesRes.ok) {
        setCategories(categoriesRes.options);
        categoriesRef.current = categoriesRes.options;
      }
      setLoadingLookups(false);
    })();
    lookupsLoadPromiseRef.current = promise;
    return () => {
      cancelled = true;
    };
  }, []);

  const projectCategories = projects.find((p) => p.id === projectId)?.categories ?? [];

  async function handleReceipt(input: File | null) {
    if (!input) {
      setReceipt(null);
      setExtractError(null);
      return;
    }
    const supported = input.type.startsWith('image/') || input.type === 'application/pdf';
    if (!supported) {
      setReceipt(input);
      setExtractError(null);
      return;
    }

    // Compress images once up front so the OCR call AND the final submit
    // upload both ship a smaller payload — critical on weak cell signal.
    const file = await compressReceiptIfImage(input);
    setReceipt(file);
    await runExtract(file);
  }

  async function runExtract(file: File) {
    setExtracting(true);
    setExtractError(null);
    setSuggestedFromOcr(false);
    try {
      // Wait for the initial lookups fetch so a fast user (open dialog
      // → snap → upload in <200ms) can't outrun it and ship an empty
      // candidate list. After this awaits, the refs are guaranteed
      // populated regardless of React render timing.
      if (lookupsLoadPromiseRef.current) {
        await lookupsLoadPromiseRef.current;
      }

      const fd = new FormData();
      fd.append('receipt', file);
      // Pass the candidate category list that matches the current mode so
      // Henry can pre-fill it. Project mode → that project's budget
      // categories. Overhead mode → the tenant's chart of accounts (parent
      // headers filtered out — they aren't selectable). Project mode with
      // no project picked yet → no candidates; operator picks manually
      // after picking the project.
      let candidates: Array<{ id: string; label: string }> = [];
      if (mode === 'overhead') {
        candidates = categoriesRef.current
          .filter((c) => !c.isParentHeader)
          .map((c) => ({ id: c.id, label: c.label }));
      } else if (mode === 'project' && projectId) {
        const project = projectsRef.current.find((p) => p.id === projectId);
        if (project && project.categories.length > 0) {
          candidates = project.categories.map((c) => ({ id: c.id, label: c.name }));
        }
      }
      if (candidates.length > 0) {
        fd.append('category_options', JSON.stringify(candidates));
      }
      const res = await withTimeout(extractReceiptFieldsAction(fd), OCR_TIMEOUT_MS);
      if (!res.ok) {
        setExtractError(res.error);
        return;
      }
      // Never silently overwrite values the operator has already typed.
      const fields = res.fields;
      if (fields.amountCents != null && !amount.trim()) {
        setAmount((fields.amountCents / 100).toFixed(2));
        // OCR breakdown wins over auto-split when reconciled. If OCR
        // couldn't reconcile, fall through to auto-split from the rate.
        if (fields.preTaxAmountCents !== null && fields.taxAmountCents !== null) {
          setPreTaxCents(fields.preTaxAmountCents);
          setTaxCents(fields.taxAmountCents);
          setSplitMode('ocr');
        } else {
          const split = splitTotalByRate(fields.amountCents, tenantTaxRate);
          setPreTaxCents(split.preTaxCents);
          setTaxCents(split.taxCents);
          setSplitMode('auto');
        }
      }
      if (fields.vendor && !vendor.trim()) setVendor(fields.vendor);
      if (fields.vendorGstNumber && !vendorGstNumber.trim()) {
        setVendorGstNumber(fields.vendorGstNumber);
      }
      if (fields.expenseDate) setDate(fields.expenseDate);
      if (fields.description && !description.trim()) setDescription(fields.description);
      // Apply Henry's category suggestion to the right slot for the
      // current mode — overhead writes to overheadCategoryId, project
      // writes to budgetCategoryId. Don't overwrite an explicit pick.
      if (fields.categoryId) {
        if (mode === 'overhead' && !overheadCategoryId) {
          setOverheadCategoryId(fields.categoryId);
          setSuggestedFromOcr(true);
        } else if (mode === 'project' && !budgetCategoryId) {
          setBudgetCategoryId(fields.categoryId);
          setSuggestedFromOcr(true);
        }
      }
      toast.success('Receipt read — review and save.');
    } catch (err) {
      // Timeout or thrown network error. Inline chip is the durable
      // surface; toast can scroll off-screen on phones.
      setExtractError(
        isTimeoutError(err)
          ? "Couldn't reach Henry — weak signal? Retry the scan or fill the form by hand."
          : 'Could not read receipt. Retry or fill the form by hand.',
      );
    } finally {
      setExtracting(false);
    }
  }

  function handleRetryExtract() {
    if (receipt) void runExtract(receipt);
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
        {extractError ? (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-destructive/10 px-2 py-1.5">
            <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <p className="flex-1 text-xs text-destructive">{extractError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRetryExtract}
              disabled={extracting || !receipt}
              className="h-7 shrink-0 gap-1 px-2 text-xs"
            >
              <RefreshCw className="size-3" />
              Retry
            </Button>
          </div>
        ) : null}
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/30 p-1">
        <ModeButton
          active={mode === 'project'}
          onClick={() => {
            setMode('project');
            setSuggestedFromOcr(false);
            refreshAutoSplit();
          }}
        >
          Project expense
        </ModeButton>
        <ModeButton
          active={mode === 'overhead'}
          onClick={() => {
            setMode('overhead');
            setSuggestedFromOcr(false);
            refreshAutoSplit();
          }}
        >
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
              onValueChange={(v) => {
                setProjectId(v);
                // Picking a cost-plus project (re-)engages auto-split;
                // picking a fixed-price one hides the chip — refreshAuto-
                // Split handles both via showTaxSplit gating downstream.
                refreshAutoSplit();
              }}
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
              onValueChange={(v) => {
                setBudgetCategoryId(v);
                setSuggestedFromOcr(false);
              }}
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
            {suggestedFromOcr && budgetCategoryId ? (
              <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="size-2.5" />
                Suggested by Henry
              </span>
            ) : null}
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
            onValueChange={(v) => {
              setOverheadCategoryId(v);
              setSuggestedFromOcr(false);
            }}
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
          {suggestedFromOcr && overheadCategoryId ? (
            <span className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Sparkles className="size-2.5" />
              Suggested by Henry
            </span>
          ) : null}
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
              // Total edit drops manual mode back to auto so the next
              // blur recomputes against the new total.
              if (splitMode !== 'auto') setSplitMode('auto');
            }}
            onBlur={(e) => {
              if (!showTaxSplit || splitMode === 'manual') return;
              const cents = Math.round(Number.parseFloat(e.target.value) * 100);
              if (!Number.isFinite(cents) || cents <= 0) {
                setPreTaxCents(null);
                setTaxCents(null);
                return;
              }
              if (splitMode === 'ocr' && preTaxCents !== null && taxCents !== null) {
                if (preTaxCents + taxCents === cents) return;
              }
              const split = splitTotalByRate(cents, tenantTaxRate);
              setPreTaxCents(split.preTaxCents);
              setTaxCents(split.taxCents);
              setSplitMode('auto');
            }}
            placeholder="0.00"
            disabled={busy}
          />
          {showTaxSplit ? (
            <ExpenseTaxSplitChip
              preTaxCents={preTaxCents}
              taxCents={taxCents}
              mode={splitMode}
              rate={tenantTaxRate}
              disabled={busy}
              onManualChange={({ preTaxCents: pt, taxCents: tx }) => {
                setPreTaxCents(pt);
                setTaxCents(tx);
                setSplitMode('manual');
              }}
              onReset={() => {
                const cents = Math.round(Number.parseFloat(amount) * 100);
                if (!Number.isFinite(cents) || cents <= 0) return;
                const split = splitTotalByRate(cents, tenantTaxRate);
                setPreTaxCents(split.preTaxCents);
                setTaxCents(split.taxCents);
                setSplitMode('auto');
              }}
            />
          ) : null}
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
