import { notFound } from 'next/navigation';
import { EstimatePreviewSendBar } from '@/components/features/projects/estimate-preview-send-bar';
import {
  EstimateRender,
  type EstimateRenderLine,
} from '@/components/features/projects/estimate-render';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Preview estimate — HeyHenry',
};

export default async function EstimatePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select(
      `id, name, description, management_fee_rate,
       estimate_status, estimate_sent_at, estimate_approved_at, estimate_approved_by_name,
       estimate_declined_at, estimate_declined_reason,
       customers:customer_id (name, email),
       tenants:tenant_id (name)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) notFound();

  const p = project as Record<string, unknown>;
  const tenantRaw = p.tenants as Record<string, unknown> | null;
  const customerRaw = p.customers as Record<string, unknown> | null;
  const managementFeeRate = Number(p.management_fee_rate) || 0;

  const { data: lines } = await supabase
    .from('project_cost_lines')
    .select('id, label, notes, qty, unit, unit_price_cents, line_price_cents, category')
    .eq('project_id', id)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  const costLines = (lines ?? []) as EstimateRenderLine[];
  const subtotal = costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFee = Math.round(subtotal * managementFeeRate);
  const total = subtotal + mgmtFee;

  const status =
    (p.estimate_status as 'draft' | 'pending_approval' | 'approved' | 'declined') ?? 'draft';

  return (
    <div className="mx-auto max-w-2xl px-4 pb-10">
      <EstimatePreviewSendBar
        projectId={id}
        customerName={(customerRaw?.name as string) ?? 'Customer'}
        customerEmail={(customerRaw?.email as string | null) ?? null}
        totalFormatted={formatCurrency(total)}
        lineCount={costLines.length}
        alreadySent={status !== 'draft'}
      />

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <p className="mb-4 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Preview — this is what {(customerRaw?.name as string) ?? 'the customer'} will see
        </p>
        <EstimateRender
          businessName={(tenantRaw?.name as string) ?? 'Your Contractor'}
          customerName={(customerRaw?.name as string) ?? 'Customer'}
          projectName={p.name as string}
          description={(p.description as string | null) ?? null}
          managementFeeRate={managementFeeRate}
          lines={costLines}
          status={status}
          approvedByName={p.estimate_approved_by_name as string | null}
          approvedAt={p.estimate_approved_at as string | null}
          declinedReason={p.estimate_declined_reason as string | null}
        />
      </div>
    </div>
  );
}
