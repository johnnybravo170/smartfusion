import { InvoicesTab } from '@/components/features/projects/invoices-tab';
import { getVarianceReport } from '@/lib/db/queries/cost-lines';
import { createClient } from '@/lib/supabase/server';

export default async function InvoicesTabServer({ projectId }: { projectId: string }) {
  const supabase = await createClient();
  const [invoicesRes, variance] = await Promise.all([
    supabase
      .from('invoices')
      .select(
        'id, status, doc_type, tax_inclusive, percent_complete, amount_cents, tax_cents, customer_note, created_at',
      )
      .eq('project_id', projectId)
      .is('deleted_at', null)
      .order('created_at', { ascending: false }),
    getVarianceReport(projectId),
  ]);

  return (
    <InvoicesTab
      projectId={projectId}
      contractRevenueCents={variance.estimated_cents}
      invoices={(invoicesRes.data ?? []).map((inv) => ({
        id: inv.id as string,
        status: inv.status as string,
        doc_type: ((inv.doc_type as string | null) ?? 'invoice') as 'invoice' | 'draw' | 'final',
        tax_inclusive: Boolean(inv.tax_inclusive),
        percent_complete: (inv.percent_complete as number | null) ?? null,
        amount_cents: inv.amount_cents as number,
        tax_cents: inv.tax_cents as number,
        customer_note: inv.customer_note as string | null,
        created_at: inv.created_at as string,
      }))}
    />
  );
}
