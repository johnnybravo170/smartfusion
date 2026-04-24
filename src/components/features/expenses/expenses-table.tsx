'use client';

/**
 * Expenses table with batch selection.
 *
 * Same layout as the static version — date, category, vendor, optional
 * project column, tax, amount, receipt, per-row delete. Adds a checkbox
 * column and a floating action bar that appears when N > 0 rows are
 * selected: Recategorize (opens a category picker dialog) or Delete.
 *
 * Used on both /expenses and /bk/expenses. Props decide whether the
 * project column shows up and whether the delete button is rendered
 * per-row (bookkeeper view hides per-row delete on project-linked rows).
 */

import { Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { DeleteExpenseButton } from '@/components/features/expenses/delete-expense-button';
import { ReceiptPreviewButton } from '@/components/features/expenses/receipt-preview-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { CategoryPickerOption } from '@/lib/db/queries/expense-categories';
import type { OverheadExpenseRow } from '@/lib/db/queries/overhead-expenses';
import { formatCurrency } from '@/lib/pricing/calculator';
import {
  bulkDeleteExpensesAction,
  bulkRecategorizeExpensesAction,
} from '@/server/actions/overhead-expenses';

type Props = {
  expenses: OverheadExpenseRow[];
  categories: CategoryPickerOption[];
  /** true on /bk/expenses (shows project column + links). */
  showProjectColumn?: boolean;
  /** true = link row to operator edit page. false = don't render links. */
  editHrefForOverhead?: (id: string) => string;
};

export function ExpensesTable({
  expenses,
  categories,
  showProjectColumn,
  editHrefForOverhead,
}: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [recatOpen, setRecatOpen] = useState(false);
  const [targetCategory, setTargetCategory] = useState('');
  const [pending, startTransition] = useTransition();

  const selectable = useMemo(
    // Project-linked rows aren't recategorizable by bulk action (they
    // have their own edit path). Filter them out of the selectable pool.
    () => expenses.filter((e) => !e.project_id),
    [expenses],
  );

  const allSelected = selectable.length > 0 && selectable.every((e) => selected.has(e.id));

  function toggleAll(v: boolean) {
    if (v) setSelected(new Set(selectable.map((e) => e.id)));
    else setSelected(new Set());
  }

  function toggleOne(id: string, v: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (v) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function runRecategorize() {
    if (!targetCategory) return;
    const ids = Array.from(selected);
    startTransition(async () => {
      const res = await bulkRecategorizeExpensesAction({
        ids,
        category_id: targetCategory,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.updated} expense${res.updated === 1 ? '' : 's'} recategorized`);
      setSelected(new Set());
      setRecatOpen(false);
      setTargetCategory('');
      router.refresh();
    });
  }

  function runDelete() {
    const ids = Array.from(selected);
    if (
      !confirm(
        `Delete ${ids.length} expense${ids.length === 1 ? '' : 's'}? This also removes receipts.`,
      )
    )
      return;
    startTransition(async () => {
      const res = await bulkDeleteExpensesAction({ ids });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`${res.deleted} expense${res.deleted === 1 ? '' : 's'} deleted`);
      setSelected(new Set());
      router.refresh();
    });
  }

  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="w-10 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={(e) => toggleAll(e.target.checked)}
                  disabled={selectable.length === 0}
                />
              </th>
              <th className="px-4 py-3 text-left font-medium">Date</th>
              <th className="px-4 py-3 text-left font-medium">Category</th>
              <th className="px-4 py-3 text-left font-medium">Vendor</th>
              {showProjectColumn ? (
                <th className="px-4 py-3 text-left font-medium">Project</th>
              ) : (
                <th className="px-4 py-3 text-left font-medium">Description</th>
              )}
              <th className="px-4 py-3 text-right font-medium">Tax</th>
              <th className="px-4 py-3 text-right font-medium">Amount</th>
              <th className="w-px px-2 py-3" aria-label="Receipt" />
              <th className="w-px px-2 py-3" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {expenses.map((e) => {
              const editHref = e.project_id
                ? `/projects/${e.project_id}?tab=costs`
                : (editHrefForOverhead?.(e.id) ?? `/expenses/${e.id}/edit`);
              const catLabel = e.parent_category_name
                ? `${e.parent_category_name} › ${e.category_name}`
                : (e.category_name ?? '—');
              const isSelectable = !e.project_id;
              return (
                <tr key={e.id} className="group border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      disabled={!isSelectable}
                      checked={selected.has(e.id)}
                      onChange={(ev) => toggleOne(e.id, ev.target.checked)}
                    />
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    <Link href={editHref} className="hover:underline">
                      {new Date(e.expense_date).toLocaleDateString('en-CA', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={editHref}
                      className={
                        e.category_id
                          ? 'hover:underline'
                          : 'font-medium text-amber-700 hover:underline dark:text-amber-300'
                      }
                    >
                      {e.category_id ? catLabel : 'Uncategorized'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{e.vendor ?? '—'}</td>
                  {showProjectColumn ? (
                    <td className="px-4 py-3 text-muted-foreground">
                      {e.project_id ? (
                        <Link
                          href={`/projects/${e.project_id}`}
                          className="text-xs hover:underline"
                        >
                          project →
                        </Link>
                      ) : (
                        <span className="text-xs">overhead</span>
                      )}
                    </td>
                  ) : (
                    <td className="max-w-md truncate px-4 py-3 text-muted-foreground">
                      {e.description ?? '—'}
                    </td>
                  )}
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {e.tax_cents > 0 ? formatCurrency(e.tax_cents) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {formatCurrency(e.amount_cents)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    <ReceiptPreviewButton
                      url={e.receipt_signed_url}
                      mimeHint={e.receipt_mime_hint}
                      vendor={e.vendor}
                    />
                  </td>
                  <td className="px-2 py-3 text-right">
                    {isSelectable ? (
                      <DeleteExpenseButton
                        id={e.id}
                        label={e.vendor ?? e.description ?? 'this expense'}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected.size > 0 ? (
        <div className="sticky bottom-4 z-10 mx-auto flex w-fit items-center gap-2 rounded-full border bg-background px-4 py-2 shadow-lg">
          <span className="text-sm font-medium">{selected.size} selected</span>
          <span className="text-muted-foreground">·</span>
          <Button size="sm" variant="outline" onClick={() => setRecatOpen(true)} disabled={pending}>
            Recategorize
          </Button>
          <Button size="sm" variant="outline" onClick={runDelete} disabled={pending}>
            <Trash2 className="size-3.5" />
            Delete
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            aria-label="Clear selection"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      <Dialog open={recatOpen} onOpenChange={setRecatOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              Recategorize {selected.size} expense{selected.size === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>
              Pick a category. Rows in locked periods are silently skipped.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bulk-cat">Category</Label>
            <select
              id="bulk-cat"
              value={targetCategory}
              onChange={(e) => setTargetCategory(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">— Pick a category —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id} disabled={c.isParentHeader}>
                  {c.label}
                  {c.isParentHeader ? ' (sub-accounts below)' : ''}
                </option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setRecatOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="button" onClick={runRecategorize} disabled={pending || !targetCategory}>
              {pending ? 'Updating…' : 'Apply'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
