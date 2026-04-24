import {
  EstimateRender,
  type EstimateRenderLine,
} from '@/components/features/projects/estimate-render';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createAdminClient } from '@/lib/supabase/admin';
import { EstimateApprovalForm } from './approval-form';
import { ViewLogger } from './view-logger';

export const metadata = {
  title: 'Estimate — HeyHenry',
};

const LOGO_SIGN_SECONDS = 60 * 60 * 24 * 30;

export default async function EstimatePage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select(
      `id, name, description, management_fee_rate, estimate_sent_at, tenant_id,
       estimate_status, estimate_approved_at, estimate_approved_by_name,
       estimate_declined_reason,
       customers:customer_id (name, address_line1, tax_exempt),
       tenants:tenant_id (name, logo_storage_path, gst_number, wcb_number)`,
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

  // Sign the tenant logo (private `photos` bucket).
  let logoUrl: string | null = null;
  const logoPath = tenantRaw?.logo_storage_path as string | null;
  if (logoPath) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrl(logoPath, LOGO_SIGN_SECONDS);
    logoUrl = signed?.signedUrl ?? null;
  }

  const [{ data: lines }, { data: buckets }] = await Promise.all([
    admin
      .from('project_cost_lines')
      .select(
        'id, label, notes, qty, unit, unit_price_cents, line_price_cents, category, bucket_id, photo_storage_paths',
      )
      .eq('project_id', p.id as string)
      .order('created_at', { ascending: true }),
    admin
      .from('project_cost_buckets')
      .select('id, name, section, display_order')
      .eq('project_id', p.id as string),
  ]);
  const bucketInfo = new Map<string, { name: string; section: string | null; order: number }>();
  for (const b of buckets ?? []) {
    bucketInfo.set(b.id as string, {
      name: (b.name as string) ?? '',
      section: (b.section as string | null) ?? null,
      order: (b.display_order as number) ?? 0,
    });
  }

  // Sign every cost-line photo in a single batch; map back by path.
  const allPhotoPaths = Array.from(
    new Set(
      (lines ?? []).flatMap(
        (l) => (l as { photo_storage_paths?: string[] }).photo_storage_paths ?? [],
      ),
    ),
  );
  const photoUrlByPath = new Map<string, string>();
  if (allPhotoPaths.length > 0) {
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(allPhotoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) photoUrlByPath.set(row.path, row.signedUrl);
    }
  }

  const renderLines: EstimateRenderLine[] = (lines ?? []).map((l) => {
    const raw = l as {
      photo_storage_paths?: string[];
      bucket_id?: string | null;
    } & EstimateRenderLine;
    const info = raw.bucket_id ? bucketInfo.get(raw.bucket_id) : undefined;
    return {
      ...(raw as EstimateRenderLine),
      bucket_name: info?.name ?? null,
      bucket_section: info?.section ?? null,
      bucket_order: info?.order,
      photo_urls: (raw.photo_storage_paths ?? [])
        .map((p) => photoUrlByPath.get(p) ?? '')
        .filter(Boolean),
    };
  });

  const status = p.estimate_status as 'draft' | 'pending_approval' | 'approved' | 'declined';

  const taxExempt = Boolean(customerRaw?.tax_exempt);
  const taxCtx = await canadianTax.getContext(p.tenant_id as string);
  const effectiveGstRate = taxExempt ? 0 : taxCtx.totalRate;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <ViewLogger code={code} />
      <EstimateRender
        businessName={(tenantRaw?.name as string) ?? 'Your Contractor'}
        logoUrl={logoUrl}
        customerName={(customerRaw?.name as string) ?? 'Customer'}
        customerAddress={(customerRaw?.address_line1 as string | null) ?? null}
        projectName={p.name as string}
        description={(p.description as string | null) ?? null}
        managementFeeRate={Number(p.management_fee_rate) || 0}
        gstRate={effectiveGstRate}
        taxLabel={taxExempt ? 'Tax exempt' : taxCtx.breakdown.map((b) => b.label).join(' + ')}
        quoteDate={(p.estimate_sent_at as string | null) ?? null}
        lines={renderLines}
        status={status}
        approvedByName={p.estimate_approved_by_name as string | null}
        approvedAt={p.estimate_approved_at as string | null}
        declinedReason={p.estimate_declined_reason as string | null}
        gstNumber={(tenantRaw?.gst_number as string | null) ?? null}
        wcbNumber={(tenantRaw?.wcb_number as string | null) ?? null}
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
