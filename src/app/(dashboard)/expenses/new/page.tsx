import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { OverheadExpenseForm } from '@/components/features/expenses/overhead-expense-form';
import { requireTenant } from '@/lib/auth/helpers';
import {
  buildCategoryTree,
  buildPickerOptions,
  listExpenseCategories,
} from '@/lib/db/queries/expense-categories';
import { canadianTax } from '@/lib/providers/tax/canadian';

export const metadata = {
  title: 'Log overhead expense — HeyHenry',
};

export default async function NewOverheadExpensePage() {
  const { tenant } = await requireTenant();
  if (tenant.member.role === 'worker') redirect('/w');

  const [rows, taxCtx] = await Promise.all([
    listExpenseCategories(),
    canadianTax.getContext(tenant.id).catch(() => null),
  ]);
  const pickerOptions = buildPickerOptions(buildCategoryTree(rows));

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <Link
        href="/expenses"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Expenses
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Log overhead expense</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            For purchases that aren&apos;t tied to a project — fuel, tools, office, software, etc.
          </p>
        </div>
        <Link
          href="/settings/categories?from=expenses"
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Manage categories →
        </Link>
      </header>

      <OverheadExpenseForm
        categories={pickerOptions}
        gstRate={taxCtx?.gstRate ?? 0}
        gstLabel={
          taxCtx?.breakdown.find((b) => b.label.startsWith('GST') || b.label.startsWith('HST'))
            ?.label ?? 'GST'
        }
      />
    </div>
  );
}
