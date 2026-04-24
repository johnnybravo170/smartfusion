import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { CategoriesManager } from '@/components/features/settings/categories-manager';
import { CoaMappingPanel } from '@/components/features/settings/coa-mapping-panel';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { buildCategoryTree, listExpenseCategories } from '@/lib/db/queries/expense-categories';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Expense categories — HeyHenry',
};

export default async function ExpenseCategoriesSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login?next=/settings/categories');

  const supabase = await createClient();
  const [rows, tenantRow] = await Promise.all([
    listExpenseCategories(),
    supabase.from('tenants').select('show_account_codes').eq('id', tenant.id).single(),
  ]);
  const tree = buildCategoryTree(rows);
  const showAccountCodes = (tenantRow.data?.show_account_codes as boolean) ?? false;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <Link
        href="/settings"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Settings
      </Link>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Expense categories</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Used on overhead expenses and project expenses. Add sub-accounts (e.g. &ldquo;Vehicles
          &rsaquo; Truck 1&rdquo;) to track the same kind of expense across multiple things.
        </p>
      </header>

      <CategoriesManager tree={tree} showAccountCodes={showAccountCodes} />

      {showAccountCodes ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Bookkeeper chart of accounts</h2>
          <p className="text-xs text-muted-foreground">
            Upload their CSV and we&apos;ll suggest a matching account code for each category.
          </p>
          <CoaMappingPanel />
        </section>
      ) : null}
    </div>
  );
}
