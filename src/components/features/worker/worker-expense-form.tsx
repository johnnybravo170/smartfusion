'use client';

import { Loader2 } from 'lucide-react';
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
import { logWorkerExpenseAction } from '@/server/actions/worker-expenses';

type Props = { projects: ProjectWithBuckets[] };

export function WorkerExpenseForm({ projects }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const initialProject = params.get('project') ?? projects[0]?.project_id ?? '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Vancouver' });

  const [pending, startTransition] = useTransition();
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
        <Label htmlFor="receipt">Receipt photo (optional)</Label>
        <Input
          id="receipt"
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
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

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
        Log expense
      </Button>
    </form>
  );
}
