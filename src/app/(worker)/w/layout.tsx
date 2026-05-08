import type { ReactNode } from 'react';
import { WorkerBottomNav } from '@/components/features/worker/worker-bottom-nav';
import { requireWorker } from '@/lib/auth/helpers';
import { TenantProvider } from '@/lib/auth/tenant-context';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export default async function WorkerLayout({ children }: { children: ReactNode }) {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);
  const admin = createAdminClient();
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_invoice_default, workers_can_log_expenses')
    .eq('id', tenant.id)
    .maybeSingle();
  const canInvoice = profile.can_invoice ?? tenantRow?.workers_can_invoice_default ?? false;
  const canLogExpenses = profile.can_log_expenses ?? tenantRow?.workers_can_log_expenses ?? true;

  return (
    <TenantProvider timezone={tenant.timezone}>
      <div className="flex min-h-screen w-full flex-col">
        <header className="border-b px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{tenant.name}</p>
        </header>
        <main className="flex-1 px-4 pb-24 pt-4">{children}</main>
        <WorkerBottomNav canInvoice={canInvoice} canLogExpenses={canLogExpenses} />
      </div>
    </TenantProvider>
  );
}
