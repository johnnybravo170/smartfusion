import { formatCurrency } from '@/lib/pricing/calculator';
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
      <div className="mx-auto max-w-lg py-20 px-4 text-center">
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
  const businessName = (tenantRaw?.name as string) ?? 'Your Contractor';
  const customerName = (customerRaw?.name as string) ?? 'Customer';
  const projectName = p.name as string;
  const mgmtRate = Number(p.management_fee_rate) || 0;

  const { data: lines } = await admin
    .from('project_cost_lines')
    .select('id, label, notes, qty, unit, unit_price_cents, line_price_cents, category')
    .eq('project_id', p.id as string)
    .order('category', { ascending: true })
    .order('created_at', { ascending: true });

  const costLines = (lines ?? []) as Array<{
    id: string;
    label: string;
    notes: string | null;
    qty: number;
    unit: string;
    unit_price_cents: number;
    line_price_cents: number;
    category: string;
  }>;

  const subtotal = costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFee = Math.round(subtotal * mgmtRate);
  const total = subtotal + mgmtFee;

  const status = p.estimate_status as string;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <ViewLogger code={code} />
      <div className="mb-6 text-center">
        <p className="text-sm font-medium text-muted-foreground">{businessName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Estimate</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {projectName} · for {customerName}
        </p>
      </div>

      {status === 'approved' ? (
        <div className="mb-6 rounded-md bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Approved by {p.estimate_approved_by_name as string} on{' '}
          {new Date(p.estimate_approved_at as string).toLocaleDateString('en-CA', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
          .
        </div>
      ) : null}
      {status === 'declined' ? (
        <div className="mb-6 rounded-md bg-red-50 px-4 py-3 text-sm text-red-800">
          This estimate was declined.
          {p.estimate_declined_reason ? ` Reason: ${p.estimate_declined_reason as string}` : ''}
        </div>
      ) : null}
      {status === 'draft' ? (
        <div className="mb-6 rounded-md bg-amber-50 px-4 py-3 text-sm text-amber-800">
          This estimate is not yet published.
        </div>
      ) : null}

      {p.description ? (
        <p className="mb-6 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">
          {p.description as string}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2 text-left font-medium">Item</th>
              <th className="px-3 py-2 text-right font-medium">Qty</th>
              <th className="px-3 py-2 text-left font-medium">Unit</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {costLines.map((l) => (
              <tr key={l.id} className="border-b last:border-0 align-top">
                <td className="px-3 py-2">
                  <p className="font-medium">{l.label}</p>
                  {l.notes ? (
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">{l.notes}</p>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right">{Number(l.qty)}</td>
                <td className="px-3 py-2 text-muted-foreground">{l.unit}</td>
                <td className="px-3 py-2 text-right">{formatCurrency(l.unit_price_cents)}</td>
                <td className="px-3 py-2 text-right font-medium">
                  {formatCurrency(l.line_price_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Subtotal</span>
          <span>{formatCurrency(subtotal)}</span>
        </div>
        {mgmtFee > 0 ? (
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              Management fee ({Math.round(mgmtRate * 100)}%)
            </span>
            <span>{formatCurrency(mgmtFee)}</span>
          </div>
        ) : null}
        <div className="flex justify-between border-t pt-2 text-base font-semibold">
          <span>Total</span>
          <span>{formatCurrency(total)}</span>
        </div>
      </div>

      {status === 'pending_approval' ? (
        <div className="mt-8 rounded-lg border p-5">
          <EstimateApprovalForm approvalCode={code} />
        </div>
      ) : null}
    </div>
  );
}
