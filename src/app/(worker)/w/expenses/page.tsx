import { Plus } from 'lucide-react';
import Link from 'next/link';
import { WorkerExpenseList } from '@/components/features/worker/worker-expense-list';
import { Button } from '@/components/ui/button';
import { requireWorker } from '@/lib/auth/helpers';
import { listWorkerExpenses } from '@/lib/db/queries/worker-expenses';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function WorkerExpensesPage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const expenses = await listWorkerExpenses(tenant.id, profile.id);

  const paths = expenses.map((e) => e.receipt_storage_path).filter((p): p is string => !!p);
  const urlMap = new Map<string, string>();
  if (paths.length > 0) {
    const admin = createAdminClient();
    const { data } = await admin.storage.from('receipts').createSignedUrls(paths, 3600);
    if (data) {
      for (let i = 0; i < data.length; i++) {
        const entry = data[i];
        if (entry?.signedUrl && !entry.error) urlMap.set(paths[i], entry.signedUrl);
      }
    }
  }

  const rows = expenses.map((e) => ({
    ...e,
    receiptUrl: e.receipt_storage_path ? (urlMap.get(e.receipt_storage_path) ?? null) : null,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Expenses</h1>
        <Button asChild size="sm">
          <Link href="/w/expenses/new">
            <Plus className="size-4" /> Log expense
          </Link>
        </Button>
      </div>
      <WorkerExpenseList entries={rows} />
    </div>
  );
}
