import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { WorkerExpenseForm } from '@/components/features/worker/worker-expense-form';
import { requireWorker } from '@/lib/auth/helpers';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { listWorkerProjectsWithBudgetCategories } from '@/lib/db/queries/worker-time';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function WorkerLogExpensePage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_log_expenses')
    .eq('id', tenant.id)
    .maybeSingle();
  const canLogExpenses = profile.can_log_expenses ?? tenantRow?.workers_can_log_expenses ?? true;
  if (!canLogExpenses) redirect('/w');

  const projects = await listWorkerProjectsWithBudgetCategories(tenant.id, profile.id);

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/w/expenses"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-3.5" /> Expenses
      </Link>
      <h1 className="text-2xl font-semibold">Log expense</h1>
      <WorkerExpenseForm projects={projects} />
    </div>
  );
}
