'use client';

/**
 * Expenses section rendered on the project Costs tab. Previously lived
 * on the Time & Expenses tab mixed with labour; moved here so the full
 * cost lifecycle (sub quote → PO → bill → expense) stays together under
 * one tab.
 *
 * Inline "log expense" form with receipt upload + per-row edit dialog +
 * delete. Negative amounts allowed (credits / returns).
 */

import { useState, useTransition } from 'react';
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
import {
  deleteExpenseAction,
  logExpenseWithReceiptAction,
  updateExpenseAction,
} from '@/server/actions/expenses';

export type ExpenseItem = {
  id: string;
  expense_date: string;
  amount_cents: number;
  vendor: string | null;
  description: string | null;
  budget_category_id: string | null;
  worker_profile_id: string | null;
  worker_name: string | null;
  receipt_url: string | null;
};

type Bucket = { id: string; name: string };

// ─── Inline add form ─────────────────────────────────────────────────────────

function ExpenseForm({
  projectId,
  buckets,
  onDone,
}: {
  projectId: string;
  buckets: Bucket[];
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
      fd.set('budget_category_id', bucketId);
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
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
            placeholder="0.00"
            required
          />
          <p className="mt-1 text-[11px] text-muted-foreground">
            Use a negative number for credits/returns.
          </p>
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

// ─── Edit dialog ─────────────────────────────────────────────────────────────

function EditExpenseDialog({
  expense,
  buckets,
  onClose,
}: {
  expense: ExpenseItem;
  buckets: Bucket[];
  onClose: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [amountRaw, setAmountRaw] = useState(() => (expense.amount_cents / 100).toFixed(2));
  const [date, setDate] = useState(expense.expense_date);
  const [vendor, setVendor] = useState(expense.vendor ?? '');
  const [description, setDescription] = useState(expense.description ?? '');
  const [bucketId, setBucketId] = useState(expense.budget_category_id ?? '');
  const [error, setError] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = parseFloat(amountRaw);
    if (!Number.isFinite(parsed) || parsed === 0) {
      setError('Amount must be non-zero.');
      return;
    }
    startTransition(async () => {
      const res = await updateExpenseAction({
        id: expense.id,
        expense_date: date,
        amount_cents: Math.round(parsed * 100),
        vendor: vendor || null,
        description: description || null,
        budget_category_id: bucketId || null,
      });
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error);
        return;
      }
      toast.success('Expense updated.');
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit expense</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-exp-date">Date</Label>
              <Input
                id="edit-exp-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                required
                disabled={pending}
              />
            </div>
            <div>
              <Label htmlFor="edit-exp-amt">Amount ($)</Label>
              <Input
                id="edit-exp-amt"
                type="number"
                step="0.01"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                required
                disabled={pending}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">Negative = credit/return.</p>
            </div>
          </div>
          {buckets.length > 0 ? (
            <div>
              <Label htmlFor="edit-exp-bucket">Bucket</Label>
              <select
                id="edit-exp-bucket"
                value={bucketId}
                onChange={(e) => setBucketId(e.target.value)}
                disabled={pending}
                className="mt-1 block w-full rounded-md border px-3 py-2 text-sm"
              >
                <option value="">— None —</option>
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <Label htmlFor="edit-exp-vendor">Vendor</Label>
            <Input
              id="edit-exp-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              disabled={pending}
            />
          </div>
          <div>
            <Label htmlFor="edit-exp-desc">Description</Label>
            <Input
              id="edit-exp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={pending}
            />
          </div>
          {error ? (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main section ────────────────────────────────────────────────────────────

export function ExpensesSection({
  projectId,
  buckets,
  expenses,
}: {
  projectId: string;
  buckets: Bucket[];
  expenses: ExpenseItem[];
}) {
  const [showForm, setShowForm] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [, startTransition] = useTransition();

  const totalExpenses = expenses.reduce((s, e) => s + e.amount_cents, 0);

  function handleDelete(id: string) {
    if (!confirm('Delete this expense?')) return;
    startTransition(async () => {
      await deleteExpenseAction(id);
    });
  }

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Expenses</h3>
          <p className="text-xs text-muted-foreground">
            {formatCurrency(totalExpenses)} paid · receipts and ad-hoc purchases posted to this
            project
          </p>
        </div>
        {!showForm && (
          <Button size="sm" onClick={() => setShowForm(true)}>
            + Log expense
          </Button>
        )}
      </div>

      {showForm && (
        <div className="mb-4">
          <ExpenseForm projectId={projectId} buckets={buckets} onDone={() => setShowForm(false)} />
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
                <th className="px-3 py-2 text-left font-medium">Logged by</th>
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
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatCurrency(exp.amount_cents)}
                  </td>
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
                    <Button size="xs" variant="ghost" onClick={() => setEditingExpense(exp)}>
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => handleDelete(exp.id)}
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

      {editingExpense ? (
        <EditExpenseDialog
          key={editingExpense.id}
          expense={editingExpense}
          buckets={buckets}
          onClose={() => setEditingExpense(null)}
        />
      ) : null}
    </section>
  );
}
