'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  ExpenseTaxSplitChip,
  type TaxSplitMode,
} from '@/components/features/expenses/expense-tax-split-chip';
import { Button } from '@/components/ui/button';
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
import type { ProjectWithCategories } from '@/lib/db/queries/worker-time';
import { splitTotalByRate } from '@/lib/expenses/tax-split';
import { extractReceiptFieldsAction } from '@/server/actions/extract-receipt';
import { logWorkerExpenseAction } from '@/server/actions/worker-expenses';

type Props = {
  projects: ProjectWithCategories[];
  /** Tenant's effective GST/HST rate as a decimal (0.13 = 13% HST).
   *  Drives the auto-split chip on cost-plus projects. */
  tenantTaxRate: number;
};

export function WorkerExpenseForm({ projects, tenantTaxRate }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const initialProject = params.get('project') ?? projects[0]?.project_id ?? '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

  const [pending, startTransition] = useTransition();
  const [extracting, setExtracting] = useState(false);
  const [projectId, setProjectId] = useState(initialProject);
  const [categoryId, setCategoryId] = useState('');
  const [costLineId, setCostLineId] = useState('');
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [vendorGstNumber, setVendorGstNumber] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today);
  const [receipt, setReceipt] = useState<File | null>(null);
  // Pre-tax / tax breakdown drives the cost-plus markup base on the
  // client invoice. Three sources, tracked via splitMode:
  //   ocr     — OCR pulled it from the receipt
  //   auto    — derived from Total via the tenant tax rate (default)
  //   manual  — operator hand-edited the breakdown; do NOT recompute
  // Null pre-tax/tax = no breakdown shown (e.g. fixed-price project).
  const [preTaxCents, setPreTaxCents] = useState<number | null>(null);
  const [taxCents, setTaxCents] = useState<number | null>(null);
  const [splitMode, setSplitMode] = useState<TaxSplitMode>('auto');

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === projectId) ?? null,
    [projects, projectId],
  );
  // Skip the chip when no tax rate is configured (legacy/no-tax tenant).
  const showTaxSplit = tenantTaxRate > 0 && Boolean(selectedProject?.is_cost_plus);

  const categories = useMemo(() => selectedProject?.categories ?? [], [selectedProject]);
  const costLines = useMemo(
    () => categories.find((b) => b.id === categoryId)?.cost_lines ?? [],
    [categories, categoryId],
  );

  async function handleReceiptPick(file: File | null) {
    setReceipt(file);
    if (!file) return;

    // gpt-4o-mini reads images and PDFs both; anything else skips extract.
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
      // Only fill fields the user hasn't already typed into.
      const {
        amountCents,
        preTaxAmountCents,
        taxAmountCents,
        vendor: v,
        vendorGstNumber: bn,
        expenseDate,
        description: d,
      } = res.fields;
      let filled = 0;
      if (amountCents != null && !amount) {
        setAmount((amountCents / 100).toFixed(2));
        // Receipt breakdown wins over auto-split. If OCR didn't reconcile
        // the breakdown (both null) we'll auto-split on next blur.
        if (preTaxAmountCents !== null && taxAmountCents !== null) {
          setPreTaxCents(preTaxAmountCents);
          setTaxCents(taxAmountCents);
          setSplitMode('ocr');
        } else {
          const split = splitTotalByRate(amountCents, tenantTaxRate);
          setPreTaxCents(split.preTaxCents);
          setTaxCents(split.taxCents);
          setSplitMode('auto');
        }
        filled++;
      }
      if (v && !vendor) {
        setVendor(v);
        filled++;
      }
      if (bn && !vendorGstNumber) {
        setVendorGstNumber(bn);
        filled++;
      }
      if (expenseDate && date === today) {
        setDate(expenseDate);
        filled++;
      }
      if (d && !description) {
        setDescription(d);
        filled++;
      }
      if (filled > 0) {
        toast.success(`Read ${filled} field${filled === 1 ? '' : 's'} from the receipt.`);
      } else {
        toast.message("Couldn't read anything clearly — fill in below.");
      }
    } finally {
      setExtracting(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter an amount.');
      return;
    }
    const fd = new FormData();
    fd.append('project_id', projectId);
    if (categoryId) fd.append('budget_category_id', categoryId);
    if (costLineId) fd.append('cost_line_id', costLineId);
    fd.append('amount_cents', String(Math.round(amt * 100)));
    // pre_tax_amount_cents goes to the new column; tax_cents is the
    // pre-existing column the bookkeeping flows already use.
    if (preTaxCents != null) fd.append('pre_tax_amount_cents', String(preTaxCents));
    if (taxCents != null) fd.append('tax_cents', String(taxCents));
    fd.append('vendor', vendor);
    fd.append('vendor_gst_number', vendorGstNumber);
    fd.append('description', description);
    fd.append('expense_date', date);
    if (receipt) fd.append('receipt', receipt);

    startTransition(async () => {
      const res = await logWorkerExpenseAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success('Expense logged.');
      router.push('/w/expenses');
    });
  }

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">You aren&apos;t assigned to any projects yet.</p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* Receipt dropzone — top of form. Picking triggers auto-extract so the
          fields below pre-fill. User reviews + corrects before submit. */}
      <div className="space-y-1.5 rounded-lg border-2 border-dashed bg-muted/30 p-4">
        <Label htmlFor="receipt" className="text-sm font-medium">
          Scan receipt
        </Label>
        <Input
          id="receipt"
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          onChange={(e) => handleReceiptPick(e.target.files?.[0] ?? null)}
        />
        <p className="text-xs text-muted-foreground">
          Snap or upload a photo (or PDF) and the amount, vendor, and date will fill themselves in.
        </p>
        {extracting ? (
          <p className="flex items-center gap-1.5 text-xs text-primary">
            <Loader2 className="size-3 animate-spin" /> Reading receipt…
          </p>
        ) : receipt ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="size-3" /> {receipt.name}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="project">Project</Label>
        <Select
          value={projectId}
          onValueChange={(v) => {
            setProjectId(v);
            setCategoryId('');
            // If the new project is cost-plus and we have an amount,
            // (re-)engage auto-split. Manual edits are project-scoped —
            // moving project means the operator's tax assumption is
            // stale.
            const next = projects.find((p) => p.project_id === v);
            if (next?.is_cost_plus) {
              const cents = Math.round(Number.parseFloat(amount) * 100);
              if (Number.isFinite(cents) && cents > 0) {
                const split = splitTotalByRate(cents, tenantTaxRate);
                setPreTaxCents(split.preTaxCents);
                setTaxCents(split.taxCents);
                setSplitMode('auto');
              }
            }
          }}
        >
          <SelectTrigger id="project">
            <SelectValue placeholder="Pick project" />
          </SelectTrigger>
          <SelectContent>
            {projects.map((p) => (
              <SelectItem key={p.project_id} value={p.project_id}>
                {p.project_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {categories.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="category">Work area (optional)</Label>
          <Select
            value={categoryId}
            onValueChange={(v) => {
              setCategoryId(v);
              setCostLineId('');
            }}
          >
            <SelectTrigger id="category">
              <SelectValue placeholder="— none —" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {categoryId && costLines.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="cost-line">Line item (optional)</Label>
          <Select
            value={costLineId || '__none__'}
            onValueChange={(v) => setCostLineId(v === '__none__' ? '' : v)}
          >
            <SelectTrigger id="cost-line">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">— none (whole category) —</SelectItem>
              {costLines.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <Label htmlFor="amount">Amount ($)</Label>
        <Input
          id="amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
            // Total edit while in 'manual' is ambiguous — operator may
            // have re-typed the total without wanting their custom split
            // overwritten. Conservative call: drop manual values back to
            // auto so the chip recomputes off the new total on blur.
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
            // Don't clobber an OCR'd breakdown that already matches the
            // current total — only recompute when the operator changed the
            // total away from what OCR set.
            if (splitMode === 'ocr' && preTaxCents !== null && taxCents !== null) {
              if (preTaxCents + taxCents === cents) return;
            }
            const split = splitTotalByRate(cents, tenantTaxRate);
            setPreTaxCents(split.preTaxCents);
            setTaxCents(split.taxCents);
            setSplitMode('auto');
          }}
          placeholder="0.00"
          required
        />
        {showTaxSplit ? (
          <ExpenseTaxSplitChip
            preTaxCents={preTaxCents}
            taxCents={taxCents}
            mode={splitMode}
            rate={tenantTaxRate}
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

      <div className="space-y-1.5">
        <Label htmlFor="vendor">Vendor (optional)</Label>
        <Input
          id="vendor"
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          placeholder="e.g. Home Depot"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="vendor-bn">Vendor GST # (optional)</Label>
        <Input
          id="vendor-bn"
          value={vendorGstNumber}
          onChange={(e) => setVendorGstNumber(e.target.value)}
          placeholder="e.g. 123456789 RT0001"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="date">Date</Label>
        <Input
          id="date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="description">Notes (optional)</Label>
        <Textarea
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </div>

      <Button type="submit" disabled={pending || extracting} className="w-full">
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Log expense
      </Button>
    </form>
  );
}
