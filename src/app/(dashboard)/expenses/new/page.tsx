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

export const metadata = {
  title: 'Log overhead expense — HeyHenry',
};

export default async function NewOverheadExpensePage() {
  const { tenant } = await requireTenant();
  if (tenant.member.role === 'worker') redirect('/w');

  const rows = await listExpenseCategories();
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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Log overhead expense</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          For purchases that aren&apos;t tied to a project — fuel, tools, office, software, etc.
        </p>
      </header>

      <OverheadExpenseForm categories={pickerOptions} />
    </div>
  );
}
