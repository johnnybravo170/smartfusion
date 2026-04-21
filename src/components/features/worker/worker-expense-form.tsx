'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
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
import type { ProjectWithBuckets } from '@/lib/db/queries/worker-time';
import { extractReceiptFieldsAction } from '@/server/actions/extract-receipt';
import { logWorkerExpenseAction } from '@/server/actions/worker-expenses';

type Props = { projects: ProjectWithBuckets[] };

export function WorkerExpenseForm({ projects }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const initialProject = params.get('project') ?? projects[0]?.project_id ?? '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

  const [pending, startTransition] = useTransition();
  const [extracting, setExtracting] = useState(false);
  const [projectId, setProjectId] = useState(initialProject);
  const [bucketId, setBucketId] = useState('');
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(today);
  const [receipt, setReceipt] = useState<File | null>(null);

  const buckets = useMemo(
    () => projects.find((p) => p.project_id === projectId)?.buckets ?? [],
    [projects, projectId],
  );

  async function handleReceiptPick(file: File | null) {
    setReceipt(file);
    if (!file) return;

    // Only auto-extract on images. PDFs fall back to plain upload.
    if (!file.type.startsWith('image/')) return;

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
      const { amountCents, vendor: v, expenseDate, description: d } = res.fields;
      let filled = 0;
      if (amountCents != null && !amount) {
        setAmount((amountCents / 100).toFixed(2));
        filled++;
      }
      if (v && !vendor) {
        setVendor(v);
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
    if (bucketId) fd.append('bucket_id', bucketId);
    fd.append('amount_cents', String(Math.round(amt * 100)));
    fd.append('vendor', vendor);
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
          Snap or upload a photo and the amount, vendor, and date will fill themselves in. PDFs
          upload but won&apos;t auto-read.
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
            setBucketId('');
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

      {buckets.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="bucket">Work area (optional)</Label>
          <Select value={bucketId} onValueChange={setBucketId}>
            <SelectTrigger id="bucket">
              <SelectValue placeholder="— none —" />
            </SelectTrigger>
            <SelectContent>
              {buckets.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
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
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0.00"
          required
        />
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
