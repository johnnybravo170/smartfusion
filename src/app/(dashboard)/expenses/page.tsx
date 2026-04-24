import { Paperclip, Plus, Tag } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { DeleteExpenseButton } from '@/components/features/expenses/delete-expense-button';
import { Button } from '@/components/ui/button';
import { requireTenant } from '@/lib/auth/helpers';
import { listOverheadExpenses } from '@/lib/db/queries/overhead-expenses';
import { formatCurrency } from '@/lib/pricing/calculator';

export const metadata = {
  title: 'Expenses — HeyHenry',
};

export default async function OverheadExpensesPage() {
  const { tenant } = await requireTenant();
  if (tenant.member.role === 'worker') redirect('/w');

  const expenses = await listOverheadExpenses({});
  const total = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const totalTax = expenses.reduce((s, e) => s + e.tax_cents, 0);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overhead expenses</h1>
          <p className="text-sm text-muted-foreground">
            Operating costs not tied to a project — fuel, tools, office, etc.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/categories?from=expenses">
              <Tag className="size-3.5" />
              Categories
            </Link>
          </Button>
          <Button asChild>
            <Link href="/expenses/new">
              <Plus className="size-3.5" />
              Log expense
            </Link>
          </Button>
        </div>
      </header>

      {expenses.length > 0 ? (
        <div className="flex gap-4 rounded-md border bg-muted/30 px-4 py-3 text-sm">
          <span>
            <span className="text-muted-foreground">Total: </span>
            <span className="font-medium tabular-nums">{formatCurrency(total)}</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            <span className="text-muted-foreground">GST/HST: </span>
            <span className="font-medium tabular-nums">{formatCurrency(totalTax)}</span>
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            {expenses.length} {expenses.length === 1 ? 'entry' : 'entries'}
          </span>
        </div>
      ) : null}

      {expenses.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <p className="text-muted-foreground">No overhead expenses logged yet.</p>
          <Button asChild>
            <Link href="/expenses/new">
              <Plus className="mr-1 size-3.5" />
              Log your first expense
            </Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Category</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium">Description</th>
                <th className="px-4 py-3 text-right font-medium">Tax</th>
                <th className="px-4 py-3 text-right font-medium">Amount</th>
                <th className="w-px px-2 py-3" aria-label="Receipt" />
                <th className="w-px px-2 py-3" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {expenses.map((e) => (
                <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                    <Link href={`/expenses/${e.id}/edit`} className="hover:underline">
                      {new Date(e.expense_date).toLocaleDateString('en-CA', {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={`/expenses/${e.id}/edit`} className="hover:underline">
                      {e.parent_category_name
                        ? `${e.parent_category_name} › ${e.category_name}`
                        : (e.category_name ?? '—')}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <Link href={`/expenses/${e.id}/edit`} className="hover:underline">
                      {e.vendor ?? '—'}
                    </Link>
                  </td>
                  <td className="max-w-md truncate px-4 py-3 text-muted-foreground">
                    <Link href={`/expenses/${e.id}/edit`} className="hover:underline">
                      {e.description ?? '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {e.tax_cents > 0 ? formatCurrency(e.tax_cents) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">
                    {formatCurrency(e.amount_cents)}
                  </td>
                  <td className="px-2 py-3 text-right">
                    {e.receipt_storage_path ? (
                      <Paperclip className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </td>
                  <td className="px-2 py-3 text-right">
                    <DeleteExpenseButton
                      id={e.id}
                      label={e.vendor ?? e.description ?? 'this expense'}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
