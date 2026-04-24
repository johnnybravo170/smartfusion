import Link from 'next/link';
import { ExpensesTable } from '@/components/features/expenses/expenses-table';
import { requireBookkeeper } from '@/lib/auth/helpers';
import {
  buildCategoryTree,
  buildPickerOptions,
  listExpenseCategories,
} from '@/lib/db/queries/expense-categories';
import { listOverheadExpenses } from '@/lib/db/queries/overhead-expenses';
import { formatCurrency } from '@/lib/pricing/calculator';

export const metadata = {
  title: 'Expenses — Bookkeeper — HeyHenry',
};

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function BookkeeperExpensesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  await requireBookkeeper();
  const resolved = await searchParams;
  const uncategorizedOnly = resolved.uncategorized === '1';

  // Bookkeeper sees every expense — overhead AND project-linked.
  // Overhead appears with a "—" in the project column; project-linked
  // shows a link back to the project so the bookkeeper can verify
  // context if needed.
  const [expenses, categoryRows] = await Promise.all([
    listOverheadExpenses({ includeProjectExpenses: true, uncategorizedOnly }),
    listExpenseCategories(),
  ]);
  const pickerOptions = buildPickerOptions(buildCategoryTree(categoryRows));
  const total = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const totalTax = expenses.reduce((s, e) => s + e.tax_cents, 0);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
          <p className="text-sm text-muted-foreground">
            Every expense — overhead and project-linked. Click a row to recategorize.
          </p>
        </div>
        <nav className="flex items-center gap-3 text-sm">
          <Link
            href="/bk/expenses"
            className={
              uncategorizedOnly
                ? 'text-muted-foreground hover:text-foreground'
                : 'font-medium text-foreground'
            }
          >
            All
          </Link>
          <span className="text-muted-foreground">·</span>
          <Link
            href="/bk/expenses?uncategorized=1"
            className={
              uncategorizedOnly
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }
          >
            Uncategorized only
          </Link>
        </nav>
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
          <p className="text-muted-foreground">
            {uncategorizedOnly
              ? 'No uncategorized expenses. Clean slate.'
              : 'No expenses logged yet.'}
          </p>
        </div>
      ) : (
        <ExpensesTable expenses={expenses} categories={pickerOptions} showProjectColumn />
      )}
    </div>
  );
}
