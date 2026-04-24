import Link from 'next/link';
import { DeleteExpenseButton } from '@/components/features/expenses/delete-expense-button';
import { ReceiptPreviewButton } from '@/components/features/expenses/receipt-preview-button';
import { requireBookkeeper } from '@/lib/auth/helpers';
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
  const expenses = await listOverheadExpenses({
    includeProjectExpenses: true,
    uncategorizedOnly,
  });
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
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left font-medium">Date</th>
                <th className="px-4 py-3 text-left font-medium">Category</th>
                <th className="px-4 py-3 text-left font-medium">Vendor</th>
                <th className="px-4 py-3 text-left font-medium">Project</th>
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
                  : `/expenses/${e.id}/edit`;
                const catLabel = e.parent_category_name
                  ? `${e.parent_category_name} › ${e.category_name}`
                  : (e.category_name ?? '—');
                return (
                  <tr key={e.id} className="border-b last:border-0 hover:bg-muted/30">
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
                      {/* Bookkeeper can delete overhead expenses (they'd only
                          delete duplicates flagged during review). Project-
                          linked expenses are protected: delete lives on the
                          project page. */}
                      {!e.project_id ? (
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
      )}
    </div>
  );
}
