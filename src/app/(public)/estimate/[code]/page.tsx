import {
  EstimateRender,
  type EstimateRenderLine,
} from '@/components/features/projects/estimate-render';
import { createAdminClient } from '@/lib/supabase/admin';
import { EstimateApprovalForm } from './approval-form';
import { ViewLogger } from './view-logger';

export const metadata = {
  title: 'Estimate — HeyHenry',
};

export default async function EstimatePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select(
      `id, name, description, management_fee_rate,
       estimate_status, estimate_sent_at, estimate_approved_at, estimate_approved_by_name,
       estimate_declined_at, estimate_declined_reason,
       customers:customer_id (name),
       tenants:tenant_id (name)`,
    )
    .eq('estimate_approval_code', code)
    .maybeSingle();

  if (!project) {
    return (
      <div className="mx-auto max-w-lg px-4 py-20 text-center">
        <h1 className="text-2xl font-semibold">Estimate Not Found</h1>
        <p className="mt-2 text-muted-foreground">
          This link may have expired or the estimate was reset.
        </p>
      </div>
    );
  }

  const p = project as Record<string, unknown>;
  const tenantRaw = p.tenants as Record<string, unknown> | null;
  const customerRaw = p.customers as Record<string, unknown> | null;

  const { data: lines } = await admin
    .from('project_cost_lines')
    .select('id, label, notes, qty, unit, unit_price_cents, line_price_cents, category')
    .eq('project_id', p.id as string)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  const status = p.estimate_status as 'draft' | 'pending_approval' | 'approved' | 'declined';

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <ViewLogger code={code} />
      <EstimateRender
        businessName={(tenantRaw?.name as string) ?? 'Your Contractor'}
        customerName={(customerRaw?.name as string) ?? 'Customer'}
        projectName={p.name as string}
        description={(p.description as string | null) ?? null}
        managementFeeRate={Number(p.management_fee_rate) || 0}
        lines={(lines ?? []) as EstimateRenderLine[]}
        status={status}
        approvedByName={p.estimate_approved_by_name as string | null}
        approvedAt={p.estimate_approved_at as string | null}
        declinedReason={p.estimate_declined_reason as string | null}
      />

      {status === 'pending_approval' ? (
        <div className="mt-8 rounded-lg border p-5">
          <EstimateApprovalForm
            approvalCode={code}
            lines={(lines ?? []).map((l) => ({ id: l.id, label: l.label }))}
          />
        </div>
      ) : null}
    </div>
  );
}
