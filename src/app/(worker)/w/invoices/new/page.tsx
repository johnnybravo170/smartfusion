import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { WorkerInvoiceNewForm } from '@/components/features/worker/worker-invoice-new-form';
import { requireWorker } from '@/lib/auth/helpers';
import { previewUnbilledForWorker } from '@/lib/db/queries/worker-invoices';
import { getOrCreateWorkerProfile } from '@/lib/db/queries/worker-profiles';
import { listWorkerProjectsWithBudgetCategories } from '@/lib/db/queries/worker-time';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function WorkerInvoiceNewPage() {
  const { tenant } = await requireWorker();
  const profile = await getOrCreateWorkerProfile(tenant.id, tenant.member.id);

  const admin = createAdminClient();
  const { data: tenantRow } = await admin
    .from('tenants')
    .select('workers_can_invoice_default')
    .eq('id', tenant.id)
    .maybeSingle();
  const canInvoice = profile.can_invoice ?? tenantRow?.workers_can_invoice_default ?? false;
  if (!canInvoice) redirect('/w');

  const projects = await listWorkerProjectsWithBudgetCategories(tenant.id, profile.id);

  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 14);
  const initialRange = { from: isoDate(start), to: isoDate(today) };

  const initialPreview = await previewUnbilledForWorker({
    tenantId: tenant.id,
    workerProfileId: profile.id,
    projectId: null,
    fromDate: initialRange.from,
    toDate: initialRange.to,
  });

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/w/invoices"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeft className="size-3.5" /> Invoices
      </Link>
      <h1 className="text-2xl font-semibold">New invoice</h1>
      <WorkerInvoiceNewForm
        projects={projects.map((p) => ({ project_id: p.project_id, project_name: p.project_name }))}
        defaultTaxRate={profile.tax_rate}
        initialPreview={initialPreview}
        initialRange={initialRange}
      />
    </div>
  );
}
