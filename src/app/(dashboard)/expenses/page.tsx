import { CreditCard, Plus, Receipt, Sparkles, Tag } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ExpensesTable } from '@/components/features/expenses/expenses-table';
import { RecurringRulesCard } from '@/components/features/expenses/recurring-rules-card';
import { Button } from '@/components/ui/button';
import { requireTenant } from '@/lib/auth/helpers';
import {
  buildCategoryTree,
  buildPickerOptions,
  listExpenseCategories,
} from '@/lib/db/queries/expense-categories';
import { listActiveRecurringRules } from '@/lib/db/queries/expense-recurring';
import { listOverheadExpenses } from '@/lib/db/queries/overhead-expenses';
import { listPaymentSources, toLite } from '@/lib/db/queries/payment-sources';
import { formatCurrency } from '@/lib/pricing/calculator';

export const metadata = {
  title: 'Expenses — HeyHenry',
};

export default async function OverheadExpensesPage() {
  const { tenant } = await requireTenant();
  if (tenant.member.role === 'worker') redirect('/w');

  const [expenses, recurringRules, categoryRows, sourceRows] = await Promise.all([
    listOverheadExpenses({}),
    listActiveRecurringRules(),
    listExpenseCategories(),
    listPaymentSources(),
  ]);
  const pickerOptions = buildPickerOptions(buildCategoryTree(categoryRows));
  const paymentSources = toLite(sourceRows);
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
            <Link href="/expenses/gst">
              <Receipt className="size-3.5" />
              GST/HST
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/categories?from=expenses">
              <Tag className="size-3.5" />
              Categories
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/settings/payment-sources?from=expenses">
              <CreditCard className="size-3.5" />
              Payment sources
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link href="/expenses/import">
              <Sparkles className="size-3.5" />
              Import receipts
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
        <ExpensesTable
          expenses={expenses}
          categories={pickerOptions}
          paymentSources={paymentSources}
        />
      )}

      <RecurringRulesCard rules={recurringRules} />
    </div>
  );
}
