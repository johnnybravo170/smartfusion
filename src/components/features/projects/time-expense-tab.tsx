'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { logTimeAction, deleteTimeEntryAction } from '@/server/actions/time-entries';
import { logExpenseAction, deleteExpenseAction } from '@/server/actions/expenses';
import type { CostBucketSummary } from '@/lib/db/queries/projects';
import { formatCurrency } from '@/lib/pricing/calculator';

type TimeEntry = { id: string; entry_date: string; hours: number; notes: string | null };
type Expense = { id: string; expense_date: string; amount_cents: number; vendor: string | null; description: string | null };

function TimeForm({ projectId, buckets, onDone }: { projectId: string; buckets: CostBucketSummary[]; onDone: () => void }) {
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
      if (res.ok) { setHours(''); setNotes(''); onDone(); }
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium">Date</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Hours</label>
          <Input type="number" step="0.25" min="0.25" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="e.g. 4" required />
        </div>
        {buckets.length > 0 && (
          <div>
            <label className="mb-1 block text-xs font-medium">Bucket</label>
            <select value={bucketId} onChange={(e) => setBucketId(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
              <option value="">— none —</option>
              {buckets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Notes</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Log time'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

function ExpenseForm({ projectId, buckets, onDone }: { projectId: string; buckets: CostBucketSummary[]; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amountRaw, setAmountRaw] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [bucketId, setBucketId] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    startTransition(async () => {
      const res = await logExpenseAction({
        project_id: projectId,
        expense_date: date,
        amount_cents: Math.round(parseFloat(amountRaw) * 100),
        vendor: vendor || undefined,
        description: description || undefined,
        bucket_id: bucketId || undefined,
      });
      if (res.ok) { setAmountRaw(''); setVendor(''); setDescription(''); onDone(); }
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className="mb-1 block text-xs font-medium">Date</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Amount ($)</label>
          <Input type="number" step="0.01" min="0.01" value={amountRaw} onChange={(e) => setAmountRaw(e.target.value)} placeholder="0.00" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Vendor</label>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Optional" />
        </div>
        {buckets.length > 0 && (
          <div>
            <label className="mb-1 block text-xs font-medium">Bucket</label>
            <select value={bucketId} onChange={(e) => setBucketId(e.target.value)} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
              <option value="">— none —</option>
              {buckets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Description</label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : 'Log expense'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
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
  const [, startTransition] = useTransition();

  const totalHours = timeEntries.reduce((s, e) => s + Number(e.hours), 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount_cents, 0);

  function deleteTime(id: string) {
    if (!confirm('Delete this time entry?')) return;
    startTransition(async () => { await deleteTimeEntryAction(id); });
  }

  function deleteExpense(id: string) {
    if (!confirm('Delete this expense?')) return;
    startTransition(async () => { await deleteExpenseAction(id); });
  }

  return (
    <div className="space-y-8">
      {/* Time */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Time Entries {totalHours > 0 && <span className="ml-1 text-muted-foreground font-normal">({totalHours}h total)</span>}</h3>
          {!showTimeForm && <Button size="sm" onClick={() => setShowTimeForm(true)}>+ Log time</Button>}
        </div>
        {showTimeForm && (
          <div className="mb-4">
            <TimeForm projectId={projectId} buckets={buckets} onDone={() => setShowTimeForm(false)} />
          </div>
        )}
        {timeEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No time entries logged yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Hours</th>
                  <th className="px-3 py-2 text-left font-medium">Notes</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {timeEntries.map((entry) => (
                  <tr key={entry.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{entry.entry_date}</td>
                    <td className="px-3 py-2 text-right">{Number(entry.hours)}h</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.notes || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteTime(entry.id)}>Del</Button>
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
          <h3 className="text-sm font-semibold">Expenses {totalExpenses > 0 && <span className="ml-1 text-muted-foreground font-normal">({formatCurrency(totalExpenses)})</span>}</h3>
          {!showExpenseForm && <Button size="sm" onClick={() => setShowExpenseForm(true)}>+ Log expense</Button>}
        </div>
        {showExpenseForm && (
          <div className="mb-4">
            <ExpenseForm projectId={projectId} buckets={buckets} onDone={() => setShowExpenseForm(false)} />
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
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                  <th className="px-3 py-2 text-left font-medium">Vendor</th>
                  <th className="px-3 py-2 text-left font-medium">Description</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {expenses.map((exp) => (
                  <tr key={exp.id} className="border-b last:border-0">
                    <td className="px-3 py-2">{exp.expense_date}</td>
                    <td className="px-3 py-2 text-right">{formatCurrency(exp.amount_cents)}</td>
                    <td className="px-3 py-2">{exp.vendor || '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{exp.description || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteExpense(exp.id)}>Del</Button>
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
