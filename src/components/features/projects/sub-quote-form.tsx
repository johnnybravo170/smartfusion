'use client';

/**
 * Form for creating a new vendor quote, including the multi-bucket
 * allocation editor and inline bucket creation. Phase 1 of
 * SUB_QUOTES_PLAN.md — manual entry only. Upload/AI parsing is Phase 2.
 *
 * Allocation invariant is surfaced live: green check when balanced,
 * amber warning when over/under. Server action re-checks on accept;
 * save-as-pending allows imbalanced state.
 */

import { CheckCircle2, Paperclip, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import { formatCurrency } from '@/lib/pricing/calculator';
import { cn } from '@/lib/utils';
import {
  createProjectBucketAction,
  createSubQuoteAction,
  updateSubQuoteAction,
} from '@/server/actions/sub-quotes';

type Bucket = { id: string; name: string; section: 'interior' | 'exterior' | 'general' };

type AllocationDraft = {
  key: string;
  budget_category_id: string;
  amount_raw: string;
  notes: string;
};

export type SubQuoteInitialValues = {
  vendor_name?: string;
  vendor_email?: string;
  vendor_phone?: string;
  total_cents?: number | null;
  scope_description?: string;
  quote_date?: string;
  valid_until?: string;
  allocations?: Array<{
    budget_category_id: string;
    allocated_cents: number;
    notes?: string;
  }>;
  /**
   * The original file that was parsed. Passed straight through to
   * createSubQuoteAction as the attachment so we don't re-upload/
   * re-parse it. Omitted for a blank "New vendor quote" form.
   */
  attachment?: File;
  /**
   * Free-form notes to pre-populate — used to surface AI-unmatched
   * bucket suggestions ("AI suggested: $X for 'Kitchen tile' but no
   * matching bucket") so the operator can act on them.
   */
  notes?: string;
};

function newRow(): AllocationDraft {
  return {
    key: crypto.randomUUID(),
    budget_category_id: '',
    amount_raw: '',
    notes: '',
  };
}

function toCents(raw: string): number {
  const n = parseFloat(raw || '0');
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function SubQuoteForm({
  projectId,
  buckets: initialBuckets,
  initialValues,
  editingQuoteId,
  onDone,
}: {
  projectId: string;
  buckets: Bucket[];
  /** AI-parsed suggestions, pre-filled on mount. Undefined = blank form. */
  initialValues?: SubQuoteInitialValues;
  /** When set, the form updates this quote instead of creating a new one. */
  editingQuoteId?: string;
  onDone: () => void;
}) {
  const [buckets, setBuckets] = useState<Bucket[]>(initialBuckets);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [vendor, setVendor] = useState(initialValues?.vendor_name ?? '');
  const [email, setEmail] = useState(initialValues?.vendor_email ?? '');
  const [phone, setPhone] = useState(initialValues?.vendor_phone ?? '');
  const [totalRaw, setTotalRaw] = useState(() =>
    initialValues?.total_cents != null ? (initialValues.total_cents / 100).toFixed(2) : '',
  );
  const [scope, setScope] = useState(initialValues?.scope_description ?? '');
  const [notes, setNotes] = useState(initialValues?.notes ?? '');
  const [quoteDate, setQuoteDate] = useState(initialValues?.quote_date ?? '');
  const [validUntil, setValidUntil] = useState(initialValues?.valid_until ?? '');
  const [attachment, setAttachment] = useState<File | null>(initialValues?.attachment ?? null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<AllocationDraft[]>(() => {
    const prefilled = initialValues?.allocations ?? [];
    if (prefilled.length === 0) {
      // Default the single row to the full quote total when we know it
      // (AI extraction case). Operator can split via "Add another split"
      // — `addRow()` auto-fills the new row with the remainder.
      const row = newRow();
      const cents = initialValues?.total_cents ?? 0;
      if (cents > 0) row.amount_raw = (cents / 100).toFixed(2);
      return [row];
    }
    return prefilled.map((a) => ({
      key: crypto.randomUUID(),
      budget_category_id: a.budget_category_id,
      amount_raw: (a.allocated_cents / 100).toFixed(2),
      notes: a.notes ?? '',
    }));
  });
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [pendingRowKey, setPendingRowKey] = useState<string | null>(null);

  const totalCents = toCents(totalRaw);
  const allocatedCents = rows.reduce((s, r) => s + toCents(r.amount_raw), 0);
  const diff = totalCents - allocatedCents;
  const balanced = totalCents > 0 && diff === 0;

  // The DB enforces (sub_quote_id, bucket_id) uniqueness — i.e. a quote
  // can only have one allocation per bucket. Surface that as a clear UX
  // signal here instead of letting the operator hit a constraint error.
  const duplicateBucketId = (() => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.budget_category_id) continue;
      if (seen.has(r.budget_category_id)) return r.budget_category_id;
      seen.add(r.budget_category_id);
    }
    return null;
  })();
  const duplicateBucketName = duplicateBucketId
    ? buckets.find((b) => b.id === duplicateBucketId)?.name
    : null;

  // Sync the single-row allocation with the total when we have exactly
  // one row that's still empty. Spares the operator from retyping
  // "$288.14" in the allocation field after typing it as the total.
  // Once they add a second split or manually edit the row, the row
  // is no longer empty and this becomes a no-op. Reading rows via the
  // setter callback keeps the dep list at [totalCents] only, so this
  // doesn't refire on every keystroke inside the row.
  useEffect(() => {
    if (totalCents <= 0) return;
    setRows((prev) => {
      if (prev.length !== 1) return prev;
      if (prev[0].amount_raw !== '' && toCents(prev[0].amount_raw) !== 0) return prev;
      return [{ ...prev[0], amount_raw: (totalCents / 100).toFixed(2) }];
    });
  }, [totalCents]);

  function updateRow(
    key: string,
    field: 'budget_category_id' | 'amount_raw' | 'notes',
    value: string,
  ) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }

  function removeRow(key: string) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.key !== key)));
  }

  function addRow() {
    // Auto-fill the new row with the unallocated remainder.
    const remainder = Math.max(0, diff);
    const row = newRow();
    if (remainder > 0) row.amount_raw = (remainder / 100).toFixed(2);
    setRows((prev) => [...prev, row]);
  }

  function handleBucketChange(rowKey: string, value: string) {
    if (value === '__new__') {
      setPendingRowKey(rowKey);
      setNewBucketOpen(true);
      return;
    }
    updateRow(rowKey, 'budget_category_id', value);
  }

  function handleBucketCreated(bucket: Bucket) {
    setBuckets((prev) => [...prev, bucket]);
    if (pendingRowKey) updateRow(pendingRowKey, 'budget_category_id', bucket.id);
    setPendingRowKey(null);
    setNewBucketOpen(false);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!vendor.trim()) {
      setError('Vendor name is required.');
      return;
    }
    if (totalCents <= 0) {
      setError('Enter the quote total.');
      return;
    }
    if (duplicateBucketId) {
      setError(
        'Two splits point to the same bucket. Combine them into a single split, or pick a different bucket.',
      );
      return;
    }
    // Drop empty rows; server validates the rest.
    const cleaned = rows.filter((r) => r.budget_category_id && toCents(r.amount_raw) > 0);

    const allocationPayload = cleaned.map((r) => ({
      budget_category_id: r.budget_category_id,
      allocated_cents: toCents(r.amount_raw),
      notes: r.notes || null,
    }));

    startTransition(async () => {
      if (editingQuoteId) {
        const result = await updateSubQuoteAction({
          id: editingQuoteId,
          project_id: projectId,
          vendor_name: vendor,
          vendor_email: email,
          vendor_phone: phone,
          total_cents: totalCents,
          scope_description: scope,
          notes,
          quote_date: quoteDate,
          valid_until: validUntil,
          allocations: allocationPayload,
        });
        if (!result.ok) {
          setError(result.error);
          toast.error(result.error);
          return;
        }
        toast.success('Vendor quote updated.');
        onDone();
        return;
      }

      const fd = new FormData();
      fd.set('project_id', projectId);
      fd.set('vendor_name', vendor);
      fd.set('vendor_email', email);
      fd.set('vendor_phone', phone);
      fd.set('total_cents', String(totalCents));
      fd.set('scope_description', scope);
      fd.set('notes', notes);
      fd.set('quote_date', quoteDate);
      fd.set('valid_until', validUntil);
      fd.set('allocations', JSON.stringify(allocationPayload));
      if (attachment) fd.set('attachment', attachment);

      const result = await createSubQuoteAction(fd);
      if (!result.ok) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Vendor quote saved.');
      onDone();
    });
  }

  return (
    <>
      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-muted/30 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="sq-vendor">Vendor / subcontractor</Label>
            <Input
              id="sq-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="ABC Painting"
              disabled={pending}
              required
            />
          </div>
          <div>
            <Label htmlFor="sq-total">Total ($)</Label>
            <Input
              id="sq-total"
              type="number"
              step="0.01"
              min="0"
              value={totalRaw}
              onChange={(e) => setTotalRaw(e.target.value)}
              placeholder="18500.00"
              disabled={pending}
              required
            />
          </div>
          <div>
            <Label htmlFor="sq-email">Vendor email</Label>
            <Input
              id="sq-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="optional"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="sq-phone">Vendor phone</Label>
            <Input
              id="sq-phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="optional"
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="sq-qdate">Quote date</Label>
            <Input
              id="sq-qdate"
              type="date"
              value={quoteDate}
              onChange={(e) => setQuoteDate(e.target.value)}
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="sq-valid">Valid until</Label>
            <Input
              id="sq-valid"
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              disabled={pending}
            />
          </div>
        </div>

        <div>
          <Label htmlFor="sq-scope">Scope description</Label>
          <textarea
            id="sq-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder="Interior + exterior painting, 2-coat, trim included..."
            disabled={pending}
            rows={2}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>

        {/* Allocation editor */}
        <div className="rounded-md border bg-card p-3">
          <div className="mb-2 flex items-center justify-between">
            <Label className="text-sm font-semibold">Allocate across buckets</Label>
            <AllocationBalance
              totalCents={totalCents}
              allocatedCents={allocatedCents}
              diff={diff}
              balanced={balanced}
            />
          </div>
          {duplicateBucketId ? (
            <p className="mb-2 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
              Two splits point to{' '}
              <span className="font-medium">{duplicateBucketName ?? 'the same bucket'}</span>. Each
              bucket can only have one allocation per quote — combine the amounts into a single
              split, or pick a different bucket.
            </p>
          ) : null}
          <div className="space-y-2">
            {rows.map((row) => {
              // Hide buckets already chosen in *other* rows so the
              // operator can't repeat a selection. Keep the row's own
              // selection visible so it doesn't disappear out from under
              // them as they edit.
              const usedByOthers = new Set(
                rows
                  .filter((r) => r.key !== row.key && r.budget_category_id)
                  .map((r) => r.budget_category_id),
              );
              const availableBuckets = buckets.filter((b) => !usedByOthers.has(b.id));
              return (
                <div key={row.key} className="grid grid-cols-12 gap-2">
                  <div className="col-span-12 sm:col-span-6">
                    <select
                      value={row.budget_category_id}
                      onChange={(e) => handleBucketChange(row.key, e.target.value)}
                      disabled={pending}
                      className="block w-full rounded-md border bg-background px-3 py-2 text-sm"
                    >
                      <option value="">— Pick a bucket —</option>
                      {availableBuckets.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name} ({b.section})
                        </option>
                      ))}
                      <option value="__new__">+ New bucket…</option>
                    </select>
                  </div>
                  <div className="col-span-8 sm:col-span-4">
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      value={row.amount_raw}
                      onChange={(e) => updateRow(row.key, 'amount_raw', e.target.value)}
                      placeholder="0.00"
                      disabled={pending}
                    />
                  </div>
                  <div className="col-span-4 flex items-center justify-end gap-1 sm:col-span-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeRow(row.key)}
                      disabled={pending || rows.length === 1}
                      aria-label="Remove row"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addRow}
            disabled={pending}
            className="mt-2"
          >
            <Plus className="mr-1 size-3.5" />
            Add another split
          </Button>
        </div>

        <div>
          <Label htmlFor="sq-notes">Notes</Label>
          <textarea
            id="sq-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Private notes for your own reference"
            disabled={pending}
            rows={2}
            className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
        </div>

        {/* Attachment — create only; editing the attachment isn't supported yet. */}
        {!editingQuoteId ? (
          <div>
            <p className="mb-1 text-xs font-medium">Attachment</p>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground hover:bg-muted/30"
              onClick={() => fileRef.current?.click()}
              disabled={pending}
            >
              <Paperclip className="size-4 shrink-0" />
              {attachment ? (
                <span className="truncate text-foreground">{attachment.name}</span>
              ) : (
                <span>Attach the quote PDF or a photo (up to 10MB)</span>
              )}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setAttachment(f);
                e.target.value = '';
              }}
            />
            {attachment ? (
              <button
                type="button"
                className="mt-1 text-xs text-muted-foreground underline"
                onClick={() => setAttachment(null)}
              >
                Remove
              </button>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : editingQuoteId ? 'Save changes' : 'Save vendor quote'}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone} disabled={pending}>
            Cancel
          </Button>
        </div>
      </form>

      <NewBucketDialog
        open={newBucketOpen}
        projectId={projectId}
        onOpenChange={(open) => {
          setNewBucketOpen(open);
          if (!open) setPendingRowKey(null);
        }}
        onCreated={handleBucketCreated}
      />
    </>
  );
}

function AllocationBalance({
  totalCents,
  allocatedCents,
  diff,
  balanced,
}: {
  totalCents: number;
  allocatedCents: number;
  diff: number;
  balanced: boolean;
}) {
  if (totalCents === 0) {
    return <span className="text-xs text-muted-foreground">Enter a total first</span>;
  }
  if (balanced) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-3.5" />
        Balanced · {formatCurrency(allocatedCents)} / {formatCurrency(totalCents)}
      </span>
    );
  }
  const over = diff < 0;
  return (
    <span
      className={cn(
        'text-xs font-medium',
        over ? 'text-destructive' : 'text-amber-700 dark:text-amber-300',
      )}
    >
      {formatCurrency(allocatedCents)} / {formatCurrency(totalCents)}
      {over
        ? ` · $${(Math.abs(diff) / 100).toFixed(2)} over`
        : ` · $${(diff / 100).toFixed(2)} remaining`}
    </span>
  );
}

function NewBucketDialog({
  open,
  projectId,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  projectId: string;
  onOpenChange: (open: boolean) => void;
  onCreated: (bucket: Bucket) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [section, setSection] = useState<'interior' | 'exterior' | 'general'>('general');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    startTransition(async () => {
      const result = await createProjectBucketAction({
        projectId,
        name: name.trim(),
        section,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onCreated(result.bucket);
      setName('');
      setSection('general');
    });
  }

  function handleOpenChange(next: boolean) {
    if (!next && !pending) {
      setName('');
      setSection('general');
      setError(null);
    }
    onOpenChange(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>New cost bucket</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="nb-name">Name</Label>
            <Input
              id="nb-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Kitchen tile"
              autoFocus
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="nb-section">Section</Label>
            <select
              id="nb-section"
              value={section}
              onChange={(e) => setSection(e.target.value as 'interior' | 'exterior' | 'general')}
              disabled={pending}
              className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="general">General</option>
              <option value="interior">Interior</option>
              <option value="exterior">Exterior</option>
            </select>
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Creating…' : 'Create bucket'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
