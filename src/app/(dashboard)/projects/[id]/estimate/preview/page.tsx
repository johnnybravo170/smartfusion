import { notFound } from 'next/navigation';
import { EstimatePreviewSendBar } from '@/components/features/projects/estimate-preview-send-bar';
import {
  EstimateRender,
  type EstimateRenderLine,
} from '@/components/features/projects/estimate-render';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Preview estimate — HeyHenry',
};

const LOGO_SIGN_SECONDS = 60 * 60 * 24 * 30;

export default async function EstimatePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select(
      `id, name, description, management_fee_rate, estimate_sent_at,
       estimate_status, estimate_approved_at, estimate_approved_by_name,
       estimate_declined_reason,
       customer_id,
       customers:customer_id (name, email, address_line1),
       tenants:tenant_id (name, logo_storage_path, gst_rate, gst_number, wcb_number)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) notFound();

  const p = project as Record<string, unknown>;
  const tenantRaw = p.tenants as Record<string, unknown> | null;
  const customerRaw = p.customers as Record<string, unknown> | null;
  const managementFeeRate = Number(p.management_fee_rate) || 0;
  const gstRate = Number(tenantRaw?.gst_rate) || 0;

  // Sign the tenant logo (storage RLS would silently fail here under the
  // authed client, same reason cost-line thumbs use the admin client).
  let logoUrl: string | null = null;
  const logoPath = tenantRaw?.logo_storage_path as string | null;
  if (logoPath) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrl(logoPath, LOGO_SIGN_SECONDS);
    logoUrl = signed?.signedUrl ?? null;
  }

  const [{ data: lines }, { data: buckets }] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select(
        'id, label, notes, qty, unit, unit_price_cents, line_price_cents, category, bucket_id, photo_storage_paths',
      )
      .eq('project_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('project_cost_buckets')
      .select('id, name, section, display_order')
      .eq('project_id', id),
  ]);
  const bucketInfo = new Map<string, { name: string; section: string | null; order: number }>();
  for (const b of buckets ?? []) {
    bucketInfo.set(b.id as string, {
      name: (b.name as string) ?? '',
      section: (b.section as string | null) ?? null,
      order: (b.display_order as number) ?? 0,
    });
  }

  // Sign line photos (admin client so storage RLS doesn't silently drop us).
  const allPhotoPaths = Array.from(
    new Set(
      (lines ?? []).flatMap(
        (l) => (l as { photo_storage_paths?: string[] }).photo_storage_paths ?? [],
      ),
    ),
  );
  const photoUrlByPath = new Map<string, string>();
  if (allPhotoPaths.length > 0) {
    const admin = createAdminClient();
    const { data: signed } = await admin.storage
      .from('photos')
      .createSignedUrls(allPhotoPaths, 3600);
    for (const row of signed ?? []) {
      if (row.path && row.signedUrl) photoUrlByPath.set(row.path, row.signedUrl);
    }
  }

  const costLines: EstimateRenderLine[] = (lines ?? []).map((l) => {
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
  const subtotal = costLines.reduce((s, l) => s + l.line_price_cents, 0);
  const mgmtFee = Math.round(subtotal * managementFeeRate);
  const beforeTax = subtotal + mgmtFee;
  const gst = Math.round(beforeTax * gstRate);
  const total = beforeTax + gst;

  const status =
    (p.estimate_status as 'draft' | 'pending_approval' | 'approved' | 'declined') ?? 'draft';

  return (
    <div className="mx-auto max-w-2xl px-4 pb-10">
      <EstimatePreviewSendBar
        projectId={id}
        customerId={p.customer_id as string}
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
          logoUrl={logoUrl}
          customerName={(customerRaw?.name as string) ?? 'Customer'}
          customerAddress={(customerRaw?.address_line1 as string | null) ?? null}
          projectName={p.name as string}
          description={(p.description as string | null) ?? null}
          managementFeeRate={managementFeeRate}
          gstRate={gstRate}
          quoteDate={(p.estimate_sent_at as string | null) ?? null}
          lines={costLines}
          status={status}
          approvedByName={p.estimate_approved_by_name as string | null}
          approvedAt={p.estimate_approved_at as string | null}
          declinedReason={p.estimate_declined_reason as string | null}
          gstNumber={(tenantRaw?.gst_number as string | null) ?? null}
          wcbNumber={(tenantRaw?.wcb_number as string | null) ?? null}
        />
      </div>
    </div>
  );
}
