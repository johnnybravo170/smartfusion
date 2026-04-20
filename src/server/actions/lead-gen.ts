'use server';

/**
 * Server action for the public lead-gen quoting widget.
 *
 * This runs WITHOUT an authenticated user session. All DB writes go through
 * the admin client (bypasses RLS). The tenantId is validated against a real
 * tenant row before any inserts.
 */

import { sendEmail } from '@/lib/email/send';
import { leadNotificationHtml } from '@/lib/email/templates/lead-notification';
import {
  calculateQuoteTotal,
  calculateSurfacePrice,
  formatCurrency,
} from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { leadSubmitSchema } from '@/lib/validators/lead';

const TAX_RATE = 0.05; // 5% GST

export async function submitLeadAction(input: {
  tenantId: string;
  name: string;
  email: string;
  phone: string;
  notes?: string;
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

  // 3. Load catalog for server-side pricing (never trust client prices).
  const { data: catalogData } = await admin
    .from('service_catalog')
    .select('surface_type, price_per_sqft_cents, min_charge_cents')
    .eq('tenant_id', tenant.id)
    .eq('is_active', true);

  const catalogMap = new Map(
    (catalogData ?? []).map(
      (c: { surface_type: string; price_per_sqft_cents: number; min_charge_cents: number }) => [
        c.surface_type,
        c,
      ],
    ),
  );

  // Price each surface from catalog (server authoritative).
  const pricedSurfaces = parsed.data.surfaces.map((s) => {
    const entry = catalogMap.get(s.surface_type);
    const price_cents = entry
      ? calculateSurfacePrice(
          { surface_type: s.surface_type, sqft: s.sqft },
          entry as { surface_type: string; price_per_sqft_cents: number; min_charge_cents: number },
        )
      : s.price_cents;
    return { ...s, price_cents };
  });

  const totals = calculateQuoteTotal(pricedSurfaces, TAX_RATE);

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

  // 6. Insert quote surfaces.
  const surfaceRows = pricedSurfaces.map((s) => ({
    quote_id: quote.id,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
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
      }).catch((err) => {
        console.error('Lead notification email failed:', err);
      });
    }
  }

  return { ok: true };
}
