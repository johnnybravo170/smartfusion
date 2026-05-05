import { notFound } from 'next/navigation';
import { EstimatePreviewSendBar } from '@/components/features/projects/estimate-preview-send-bar';
import {
  EstimateRender,
  type EstimateRenderLine,
} from '@/components/features/projects/estimate-render';
import { resolveTenantAutoFollowupEnabled } from '@/lib/ar/system-sequences';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { hasFeature } from '@/lib/billing/features';
import { formatCurrency } from '@/lib/pricing/calculator';
import { canadianTax } from '@/lib/providers/tax/canadian';
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
       estimate_declined_reason, terms_text, document_type,
       customer_id, tenant_id,
       customers:customer_id (name, email, additional_emails, address_line1, tax_exempt),
       tenants:tenant_id (name, logo_storage_path, gst_number, wcb_number)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!project) notFound();

  const p = project as Record<string, unknown>;
  const tenantRaw = p.tenants as Record<string, unknown> | null;
  const customerRaw = p.customers as Record<string, unknown> | null;
  const managementFeeRate = Number(p.management_fee_rate) || 0;
  const taxExempt = Boolean(customerRaw?.tax_exempt);
  const taxCtx = await canadianTax.getContext(p.tenant_id as string);
  // Customer-facing estimates show GST/HST only — never PST/RST/QST.
  // Renovation contractors absorb PST as a materials-side cost paid to
  // suppliers; the customer doesn't see a PST line on the estimate.
  // (HST provinces are unaffected since their full rate lives under
  // gstRate.)
  const customerFacingBreakdown = taxCtx.breakdown.filter((b) => !/^(PST|RST|QST)/i.test(b.label));
  const customerFacingRate = customerFacingBreakdown.reduce((s, b) => s + b.rate, 0);
  const gstRate = taxExempt ? 0 : customerFacingRate;
  const taxLabel = taxExempt
    ? 'Tax exempt'
    : customerFacingBreakdown.map((b) => b.label).join(' + ');

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

  const [{ data: lines }, { data: categories }] = await Promise.all([
    supabase
      .from('project_cost_lines')
      .select(
        'id, label, notes, qty, unit, unit_price_cents, line_price_cents, category, budget_category_id, photo_storage_paths',
      )
      .eq('project_id', id)
      .order('created_at', { ascending: true }),
    supabase
      .from('project_budget_categories')
      .select('id, name, section, description, display_order')
      .eq('project_id', id),
  ]);
  const categoryInfo = new Map<
    string,
    { name: string; section: string | null; description: string | null; order: number }
  >();
  for (const b of categories ?? []) {
    categoryInfo.set(b.id as string, {
      name: (b.name as string) ?? '',
      section: (b.section as string | null) ?? null,
      description: (b.description as string | null) ?? null,
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
      budget_category_id?: string | null;
    } & EstimateRenderLine;
    const info = raw.budget_category_id ? categoryInfo.get(raw.budget_category_id) : undefined;
    return {
      ...(raw as EstimateRenderLine),
      budget_category_name: info?.name ?? null,
      budget_category_section: info?.section ?? null,
      budget_category_order: info?.order,
      budget_category_description: info?.description ?? null,
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

  // Auto-followup checkbox — defaults to tenant setting, gated to Growth plan.
  const tenantCtx = await getCurrentTenant();
  const autoFollowupAvailable = tenantCtx
    ? hasFeature(
        { plan: tenantCtx.plan, subscriptionStatus: tenantCtx.subscriptionStatus },
        'customers.followup_sequences',
      )
    : false;
  const autoFollowupTenantDefault = tenantCtx
    ? await resolveTenantAutoFollowupEnabled(tenantCtx.id)
    : false;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-10">
      <EstimatePreviewSendBar
        projectId={id}
        customerId={p.customer_id as string}
        customerName={(customerRaw?.name as string) ?? 'Customer'}
        customerEmail={(customerRaw?.email as string | null) ?? null}
        customerAdditionalEmails={(customerRaw?.additional_emails as string[] | null) ?? []}
        totalFormatted={formatCurrency(total)}
        lineCount={costLines.length}
        alreadySent={status !== 'draft'}
        autoFollowupTenantDefault={autoFollowupTenantDefault}
        autoFollowupAvailable={autoFollowupAvailable}
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
          taxLabel={taxLabel}
          quoteDate={(p.estimate_sent_at as string | null) ?? null}
          lines={costLines}
          status={status}
          approvedByName={p.estimate_approved_by_name as string | null}
          approvedAt={p.estimate_approved_at as string | null}
          declinedReason={p.estimate_declined_reason as string | null}
          gstNumber={(tenantRaw?.gst_number as string | null) ?? null}
          wcbNumber={(tenantRaw?.wcb_number as string | null) ?? null}
          termsText={(p.terms_text as string | null) ?? null}
          documentType={(p.document_type as 'estimate' | 'quote' | null) ?? 'estimate'}
        />
      </div>
    </div>
  );
}
