'use client';

/**
 * Confirm dialog for a vendor bill staged in the universal inbox.
 *
 * Pre-fills from a hint (V1 used `email.extracted`; V2 passes through the
 * existing prop until per-kind extraction lands in V3), lets the operator
 * edit anything that looks off, and calls applyIntakeIntentAction so a
 * project_costs row is inserted and the intake_drafts row is stamped
 * applied + linked to the new destination.
 */

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
import { createClient } from '@/lib/supabase/client';
import { applyIntakeIntentAction } from '@/server/actions/inbox-intake';

export type StagedBillExtracted = {
  vendor?: string;
  vendor_gst_number?: string;
  bill_number?: string;
  bill_date?: string;
  description?: string;
  amount_cents?: number;
  cost_code?: string;
};

type ProjectOption = { id: string; name: string };
type CategoryOption = { id: string; name: string };

function dollarsToCents(s: string): number {
  const n = Number(s.replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function centsToDollars(c: number | null | undefined): string {
  if (c == null) return '';
  return (c / 100).toFixed(2);
}

function todayISO(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

export function StagedBillConfirmDialog({
  open,
  onOpenChange,
  draftId,
  extracted,
  projects,
  defaultProjectId,
  onApplied,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** intake_drafts.id — V2 universal apply path. */
  draftId: string;
  extracted: StagedBillExtracted | null;
  projects: ProjectOption[];
  /** Pre-selected from project_match; operator can override. */
  defaultProjectId: string | null;
  onApplied: () => void;
}) {
  const tenantTz = useTenantTimezone();
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [vendor, setVendor] = useState(extracted?.vendor ?? '');
  const [vendorGst, setVendorGst] = useState(extracted?.vendor_gst_number ?? '');
  const [billDate, setBillDate] = useState(extracted?.bill_date ?? todayISO(tenantTz));
  const [amount, setAmount] = useState(centsToDollars(extracted?.amount_cents));
  const [gst, setGst] = useState('');
  const [description, setDescription] = useState(extracted?.description ?? '');
  const [categoryId, setCategoryId] = useState<string>('');
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(false);

  // Load budget categories whenever the picked project changes.
  useEffect(() => {
    if (!projectId) {
      setCategories([]);
      setCategoryId('');
      return;
    }
    let cancelled = false;
    setLoadingCategories(true);
    const supabase = createClient();
    supabase
      .from('project_budget_categories')
      .select('id, name')
      .eq('project_id', projectId)
      .order('display_order')
      .then(({ data }) => {
        if (cancelled) return;
        setCategories(((data ?? []) as { id: string; name: string }[]) ?? []);
        setLoadingCategories(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) {
      toast.error('Pick a project.');
      return;
    }
    if (!vendor.trim()) {
      toast.error('Vendor is required.');
      return;
    }
    const amountCents = dollarsToCents(amount);
    if (amountCents <= 0) {
      toast.error('Amount must be greater than zero.');
      return;
    }

    startTransition(async () => {
      const result = await applyIntakeIntentAction({
        draftId,
        intent: 'vendor_bill',
        projectId,
        fields: {
          vendor: vendor.trim(),
          vendorGstNumber: vendorGst.trim() || undefined,
          billDate,
          amountCents,
          gstCents: dollarsToCents(gst),
          description: description.trim() || undefined,
          budgetCategoryId: categoryId || undefined,
        },
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Bill applied to project.');
      onApplied();
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm vendor bill</DialogTitle>
          <DialogDescription>
            Henry pre-filled what he could from the forwarded email. Adjust anything that looks off,
            then apply.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <Label htmlFor="bill-project">Project</Label>
            <Select value={projectId} onValueChange={setProjectId} disabled={pending}>
              <SelectTrigger id="bill-project">
                <SelectValue placeholder="Pick project" />
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

          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label htmlFor="bill-vendor">Vendor</Label>
              <Input
                id="bill-vendor"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="e.g. Smith Painting"
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="bill-amount">Amount ($)</Label>
              <Input
                id="bill-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="bill-gst">GST/HST ($)</Label>
              <Input
                id="bill-gst"
                inputMode="decimal"
                value={gst}
                onChange={(e) => setGst(e.target.value)}
                placeholder="0.00"
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="bill-date">Bill date</Label>
              <Input
                id="bill-date"
                type="date"
                value={billDate}
                onChange={(e) => setBillDate(e.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="bill-vendor-gst">Vendor GST #</Label>
              <Input
                id="bill-vendor-gst"
                value={vendorGst}
                onChange={(e) => setVendorGst(e.target.value)}
                placeholder="e.g. 123456789 RT0001"
                disabled={pending}
              />
            </div>
          </div>

          <div>
            <Label htmlFor="bill-category">Budget category</Label>
            <Select
              value={categoryId}
              onValueChange={setCategoryId}
              disabled={pending || !projectId || loadingCategories}
            >
              <SelectTrigger id="bill-category">
                <SelectValue
                  placeholder={
                    !projectId
                      ? 'Pick a project first'
                      : loadingCategories
                        ? 'Loading…'
                        : 'Pick a category (optional)'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="bill-description">Description</Label>
            <Textarea
              id="bill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional notes"
              rows={2}
              disabled={pending}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Applying…' : 'Apply to project'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
