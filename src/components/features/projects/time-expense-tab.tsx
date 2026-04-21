'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CostBucketSummary } from '@/lib/db/queries/projects';
import { formatCurrency } from '@/lib/pricing/calculator';
import { deleteExpenseAction, logExpenseWithReceiptAction } from '@/server/actions/expenses';
import { deleteTimeEntryAction, logTimeAction } from '@/server/actions/time-entries';

type TimeEntry = {
  id: string;
  entry_date: string;
  hours: number;
  notes: string | null;
  worker_profile_id: string | null;
  worker_name: string | null;
};
type Expense = {
  id: string;
  expense_date: string;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  worker_profile_id: string | null;
  worker_name: string | null;
  receipt_url: string | null;
};

function TimeForm({
  projectId,
  buckets,
  onDone,
}: {
  projectId: string;
  buckets: CostBucketSummary[];
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [hours, setHours] = useState('');
  const [notes, setNotes] = useState('');
  const [bucketId, setBucketId] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const res = await logTimeAction({
        project_id: projectId,
        entry_date: date,
        hours: parseFloat(hours),
        bucket_id: bucketId || undefined,
        notes: notes || undefined,
      });
      if (res.ok) {
        setHours('');
        setNotes('');
        onDone();
      } else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <span className="mb-1 block text-xs font-medium">Date</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">Hours</span>
          <Input
            type="number"
            step="0.25"
            min="0.25"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            placeholder="e.g. 4"
            required
          />
        </div>
        {buckets.length > 0 && (
          <div>
            <span className="mb-1 block text-xs font-medium">Bucket</span>
            <select
              value={bucketId}
              onChange={(e) => setBucketId(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">— none —</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-medium">Notes</span>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Log time'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ExpenseForm({
  projectId,
  buckets,
  onDone,
}: {
  projectId: string;
  buckets: CostBucketSummary[];
  onDone: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountRaw, setAmountRaw] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [bucketId, setBucketId] = useState('');
  const [receipt, setReceipt] = useState<File | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const fd = new FormData();
      fd.set('project_id', projectId);
      fd.set('expense_date', date);
      fd.set('amount_cents', String(Math.round(parseFloat(amountRaw) * 100)));
      fd.set('vendor', vendor);
      fd.set('description', description);
      fd.set('bucket_id', bucketId);
      if (receipt) fd.set('receipt', receipt);
      const res = await logExpenseWithReceiptAction(fd);
      if (res.ok) {
        setAmountRaw('');
        setVendor('');
        setDescription('');
        setReceipt(null);
        onDone();
      } else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <span className="mb-1 block text-xs font-medium">Date</span>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">Amount ($)</span>
          <Input
            type="number"
            step="0.01"
            min="0.01"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
            placeholder="0.00"
            required
          />
        </div>
        <div>
          <span className="mb-1 block text-xs font-medium">Vendor</span>
          <Input
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
            placeholder="Optional"
          />
        </div>
        {buckets.length > 0 && (
          <div>
            <span className="mb-1 block text-xs font-medium">Bucket</span>
            <select
              value={bucketId}
              onChange={(e) => setBucketId(e.target.value)}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            >
              <option value="">— none —</option>
              {buckets.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <span className="mb-1 block text-xs font-medium">Description</span>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="sm:col-span-4">
          <span className="mb-1 block text-xs font-medium">Receipt</span>
          <Input
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
          {pending ? 'Saving…' : 'Log expense'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function TimeExpenseTab({
  projectId,
  buckets,
  timeEntries,
  expenses,
}: {
  projectId: string;
  buckets: CostBucketSummary[];
  timeEntries: TimeEntry[];
  expenses: Expense[];
}) {
  const [showTimeForm, setShowTimeForm] = useState(false);
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [workerFilter, setWorkerFilter] = useState<string>('all');
  const [, startTransition] = useTransition();

  const workerOptions = Array.from(
    new Map(
      timeEntries
        .filter((e) => e.worker_profile_id)
        .map((e) => [e.worker_profile_id as string, e.worker_name ?? 'Worker']),
    ).entries(),
  );
  const filteredTime =
    workerFilter === 'all'
      ? timeEntries
      : workerFilter === 'owner'
        ? timeEntries.filter((e) => !e.worker_profile_id)
        : timeEntries.filter((e) => e.worker_profile_id === workerFilter);

  const totalHours = filteredTime.reduce((s, e) => s + Number(e.hours), 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount_cents, 0);

  function deleteTime(id: string) {
    if (!confirm('Delete this time entry?')) return;
    startTransition(async () => {
      await deleteTimeEntryAction(id);
    });
  }

  function deleteExpense(id: string) {
    if (!confirm('Delete this expense?')) return;
    startTransition(async () => {
      await deleteExpenseAction(id);
    });
  }

  return (
    <div className="space-y-8">
      {/* Time */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Time Entries{' '}
            {totalHours > 0 && (
              <span className="ml-1 text-muted-foreground font-normal">({totalHours}h total)</span>
            )}
          </h3>
          <div className="flex items-center gap-2">
            {workerOptions.length > 0 ? (
              <select
                value={workerFilter}
                onChange={(e) => setWorkerFilter(e.target.value)}
                className="h-8 rounded-md border bg-background px-2 text-xs"
              >
                <option value="all">All workers</option>
                <option value="owner">Owner/admin</option>
                {workerOptions.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            ) : null}
            {!showTimeForm && (
              <Button size="sm" onClick={() => setShowTimeForm(true)}>
                + Log time
              </Button>
            )}
          </div>
        </div>
        {showTimeForm && (
          <div className="mb-4">
            <TimeForm
              projectId={projectId}
              buckets={buckets}
              onDone={() => setShowTimeForm(false)}
            />
          </div>
        )}
        {filteredTime.length === 0 ? (
          <p className="text-sm text-muted-foreground">No time entries logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Worker</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-left font-medium">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {filteredTime.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{entry.entry_date}</td>
                    <td className="px-3 py-2">{entry.worker_name ?? 'Owner/admin'}</td>
                    <td className="px-3 py-2 text-right">{Number(entry.hours)}h</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.notes || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteTime(entry.id)}
                      >
                        Del
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Expenses */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Expenses{' '}
            {totalExpenses > 0 && (
              <span className="ml-1 text-muted-foreground font-normal">
                ({formatCurrency(totalExpenses)})
              </span>
            )}
          </h3>
          {!showExpenseForm && (
            <Button size="sm" onClick={() => setShowExpenseForm(true)}>
              + Log expense
            </Button>
          )}
        </div>
        {showExpenseForm && (
          <div className="mb-4">
            <ExpenseForm
              projectId={projectId}
              buckets={buckets}
              onDone={() => setShowExpenseForm(false)}
            />
          </div>
        )}
        {expenses.length === 0 ? (
          <p className="text-sm text-muted-foreground">No expenses logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-left font-medium">Worker</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2 text-left font-medium">Receipt</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp) => (
                  <tr key={exp.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{exp.expense_date}</td>
                    <td className="px-3 py-2">{exp.worker_name ?? 'Owner/admin'}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(exp.amount_cents)}</td>
                    <td className="px-3 py-2">{exp.vendor || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{exp.description || '—'}</td>
                    <td className="px-3 py-2">
                      {exp.receipt_url ? (
                        <a
                          href={exp.receipt_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline"
                        >
                          View
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="xs"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={() => deleteExpense(exp.id)}
                      >
                        Del
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
