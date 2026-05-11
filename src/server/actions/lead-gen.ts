'use server';

/**
 * Server action for the public lead-gen quoting widget.
 *
 * This runs WITHOUT an authenticated user session. All DB writes go through
 * the admin client (bypasses RLS). The tenantId is validated against a real
 * tenant row before any inserts.
 */

import { headers } from 'next/headers';
import { sendEmail } from '@/lib/email/send';
import { leadNotificationHtml } from '@/lib/email/templates/lead-notification';
import {
  calculateQuoteTotal,
  calculateSurfacePrice,
  formatCurrency,
} from '@/lib/pricing/calculator';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createAdminClient } from '@/lib/supabase/admin';
import { leadSubmitSchema } from '@/lib/validators/lead';

export async function submitLeadAction(input: {
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  notes?: string;
  /** True when the lead ticked the "send me marketing" checkbox. */
  marketingOptIn?: boolean;
  /** Verbatim wording shown next to the checkbox at submission time. */
  marketingWording?: string;
  surfaces: Array<{
    surface_type: string;
    sqft: number;
    price_cents: number;
    polygon_geojson?: unknown;
  }>;
}): Promise<{ ok: boolean; error?: string }> {
  // 1. Validate input.
  const parsed = leadSubmitSchema.safeParse(input);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    return { ok: false, error: firstIssue?.message ?? 'Invalid input.' };
  }

  const admin = createAdminClient();

  // 2. Verify the tenant exists.
  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .select('id, name')
    .eq('id', parsed.data.tenantId)
    .single();

  if (tenantErr || !tenant) {
    return { ok: false, error: 'Operator not found.' };
  }

  // 3. Load catalog (per_unit/sqft items) for server-side pricing —
  // never trust client prices. Public lead form uses the admin client
  // since there's no auth context, but we still filter by tenant_id.
  const { data: catalogData, error: catalogErr } = await admin
    .from('catalog_items')
    .select('surface_type, pricing_model, unit_price_cents, min_charge_cents, unit_label')
    .eq('tenant_id', tenant.id)
    .eq('is_active', true)
    .eq('pricing_model', 'per_unit')
    .not('surface_type', 'is', null);

  if (catalogErr) {
    return { ok: false, error: `Failed to load catalog: ${catalogErr.message}` };
  }

  type CatalogRow = {
    surface_type: string;
    pricing_model: 'per_unit';
    unit_price_cents: number | null;
    min_charge_cents: number | null;
    unit_label: string | null;
  };

  const catalogMap = new Map<string, CatalogRow>();
  for (const row of (catalogData ?? []) as CatalogRow[]) {
    if (row.surface_type) catalogMap.set(row.surface_type, row);
  }

  // Price each surface from catalog (server authoritative).
  const pricedSurfaces = parsed.data.surfaces.map((s) => {
    const entry = catalogMap.get(s.surface_type);
    const price_cents = entry
      ? calculateSurfacePrice({ surface_type: s.surface_type, sqft: s.sqft }, entry)
      : s.price_cents;
    return { ...s, price_cents };
  });

  // Per-tenant rate (HST tenants get 13%/15%). Lead's customer doesn't
  // exist yet, so no tax-exempt branching here.
  const taxCtx = await canadianTax.getContext(tenant.id);
  const totals = calculateQuoteTotal(pricedSurfaces, taxCtx.totalRate);

  // 4. Create customer in the operator's tenant.
  const { data: customer, error: custErr } = await admin
    .from('customers')
    .insert({
      tenant_id: tenant.id,
      type: 'residential',
      name: parsed.data.name,
      email: parsed.data.email,
      phone: parsed.data.phone,
      notes: parsed.data.notes?.trim() || null,
    })
    .select('id')
    .single();

  if (custErr || !customer) {
    return { ok: false, error: 'Failed to save your information. Please try again.' };
  }

  // 5. Create draft quote.
  const { data: quote, error: quoteErr } = await admin
    .from('quotes')
    .insert({
      tenant_id: tenant.id,
      customer_id: customer.id,
      status: 'draft',
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      notes: `Lead from public quote widget`,
    })
    .select('id')
    .single();

  if (quoteErr || !quote) {
    return { ok: false, error: 'Failed to create your quote. Please try again.' };
  }

  // 6. Insert line items (canonical pricing), then surfaces linked to them.
  const lineItemRows = pricedSurfaces.map((s, i) => ({
    quote_id: quote.id,
    label: s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
    qty: s.sqft > 0 ? s.sqft : 1,
    unit: s.sqft > 0 ? 'sq ft' : 'item',
    unit_price_cents: s.sqft > 0 ? Math.round(s.price_cents / s.sqft) : s.price_cents,
    line_total_cents: s.price_cents,
    sort_order: i,
  }));

  const { data: lineItemData } = await admin
    .from('quote_line_items')
    .insert(lineItemRows)
    .select('id');

  const surfaceRows = pricedSurfaces.map((s, i) => ({
    quote_id: quote.id,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
    line_item_id: lineItemData?.[i]?.id ?? null,
  }));

  await admin.from('quote_surfaces').insert(surfaceRows);

  // 7. Create worklog entry.
  await admin.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'New lead from website',
    body: `${parsed.data.name} (${parsed.data.email}) requested a quote for ${formatCurrency(totals.total_cents)} via the public quote widget.`,
    related_type: 'quote',
    related_id: quote.id,
  });

  // 7b. CASL: capture marketing consent if the lead ticked the opt-in box.
  // Captures IP + user-agent + the verbatim wording that was on screen so a
  // future audit can reconstruct exactly what the recipient agreed to.
  if (input.marketingOptIn) {
    try {
      const h = await headers();
      const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h.get('x-real-ip') ?? null;
      const userAgent = h.get('user-agent') ?? null;
      await admin.from('consent_events').insert({
        tenant_id: tenant.id,
        contact_id: customer.id,
        contact_kind: 'customer',
        email: parsed.data.email,
        phone: parsed.data.phone,
        consent_type: 'general_marketing',
        source: 'intake_form',
        wording_shown: input.marketingWording ?? null,
        ip,
        user_agent: userAgent,
        evidence: {
          form: 'public_quote_widget',
          quote_id: quote.id,
          submission_total_cents: totals.total_cents,
        },
      });
    } catch (err) {
      // Non-fatal — the lead saved, the customer can re-consent later.
      console.error('[casl] consent_events insert failed:', err);
    }
  }

  // 8. Get operator info for notifications.
  const { data: memberData } = await admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenant.id)
    .eq('role', 'owner')
    .maybeSingle();

  if (memberData?.user_id) {
    const userId = memberData.user_id as string;

    // Create a todo for the operator.
    await admin.from('todos').insert({
      tenant_id: tenant.id,
      user_id: userId,
      title: `Follow up with new lead: ${parsed.data.name} - ${parsed.data.phone}`,
      related_type: 'quote',
      related_id: quote.id,
    });

    // Get operator's email from auth.users.
    const { data: userData } = await admin.auth.admin.getUserById(userId);
    const operatorEmail = userData?.user?.email;

    if (operatorEmail) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
      const surfaceSummary = pricedSurfaces
        .map(
          (s) =>
            `${s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())} (${s.sqft.toFixed(1)} sqft) - ${formatCurrency(s.price_cents)}`,
        )
        .join('<br/>');

      // Send email notification (best-effort, don't block the response).
      sendEmail({
        tenantId: tenant.id as string,
        to: operatorEmail,
        subject: `New quote request from ${parsed.data.name}`,
        html: leadNotificationHtml({
          businessName: tenant.name as string,
          customerName: parsed.data.name,
          customerEmail: parsed.data.email,
          customerPhone: parsed.data.phone,
          totalFormatted: formatCurrency(totals.total_cents),
          surfaceSummary,
          dashboardUrl: `${appUrl}/quotes/${quote.id}`,
        }),
        caslCategory: 'transactional',
        relatedType: 'lead',
        relatedId: quote.id,
        caslEvidence: { kind: 'lead_internal_notify', quoteId: quote.id },
      }).catch((err) => {
        console.error('Lead notification email failed:', err);
      });
    }
  }

  return { ok: true };
}
