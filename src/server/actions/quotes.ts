'use server';

/**
 * Server actions for the Quotes module.
 *
 * All mutations run through the RLS-aware server client. The tenant check
 * happens in the database. We resolve the tenant via `getCurrentTenant`
 * because INSERT needs an explicit `tenant_id`.
 */

import crypto from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { emitArEvent } from '@/lib/ar/event-bus';
import { ensureQuoteFollowupSequence, shouldEnrollQuoteFollowup } from '@/lib/ar/system-sequences';
import { getCurrentTenant } from '@/lib/auth/helpers';
import type { CatalogEntryRow } from '@/lib/db/queries/service-catalog';
import {
  calculateQuoteTotal,
  calculateSurfacePrice,
  formatCurrency,
} from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { emptyToNull, quoteCreateSchema, quoteUpdateSchema } from '@/lib/validators/quote';

/** Generate a URL-safe random approval code. */
function generateApprovalCode(): string {
  return crypto.randomBytes(12).toString('base64url').slice(0, 16);
}

/** Build line item rows from priced surfaces (pressure washing vertical). */
function buildLineItemRows(
  quoteId: string,
  surfaces: { surface_type: string; sqft: number; price_cents: number }[],
) {
  return surfaces.map((s, i) => ({
    quote_id: quoteId,
    label: s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    qty: s.sqft > 0 ? s.sqft : 1,
    unit: s.sqft > 0 ? 'sq ft' : 'item',
    unit_price_cents: s.sqft > 0 ? Math.round(s.price_cents / s.sqft) : s.price_cents,
    line_total_cents: s.price_cents,
    sort_order: i,
  }));
}

export type QuoteActionResult =
  | { ok: true; id: string; warning?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const TAX_RATE = 0.05; // 5% GST

export async function createQuoteAction(input: unknown): Promise<QuoteActionResult> {
  const parsed = quoteCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load catalog entries to compute pricing server-side (never trust client prices).
  const { data: catalogData, error: catErr } = await supabase
    .from('service_catalog')
    .select('surface_type, price_per_sqft_cents, min_charge_cents')
    .eq('is_active', true);

  if (catErr) {
    return { ok: false, error: `Failed to load catalog: ${catErr.message}` };
  }

  const catalog = (catalogData ?? []) as CatalogEntryRow[];
  const catalogMap = new Map(catalog.map((c) => [c.surface_type, c]));

  // Price each surface from catalog (server authoritative).
  const pricedSurfaces = parsed.data.surfaces.map((s) => {
    const entry = catalogMap.get(s.surface_type);
    const price_cents = entry
      ? calculateSurfacePrice({ surface_type: s.surface_type, sqft: s.sqft }, entry)
      : s.price_cents; // Fallback to client-provided if catalog entry missing.
    return { ...s, price_cents };
  });

  const totals = calculateQuoteTotal(pricedSurfaces, TAX_RATE);

  // Insert quote.
  const { data: quoteData, error: quoteErr } = await supabase
    .from('quotes')
    .insert({
      tenant_id: tenant.id,
      customer_id: parsed.data.customer_id,
      status: 'draft',
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      notes: emptyToNull(parsed.data.notes),
    })
    .select('id')
    .single();

  if (quoteErr || !quoteData) {
    return { ok: false, error: quoteErr?.message ?? 'Failed to create quote.' };
  }

  const quoteId = quoteData.id;

  // Insert line items first (canonical pricing output).
  const lineItemRows = buildLineItemRows(quoteId, pricedSurfaces);
  const { data: lineItemData, error: liErr } = await supabase
    .from('quote_line_items')
    .insert(lineItemRows)
    .select('id');

  if (liErr) {
    await supabase.from('quotes').delete().eq('id', quoteId);
    return { ok: false, error: `Failed to save line items: ${liErr.message}` };
  }

  // Insert surfaces with line_item_id linking back to canonical line item.
  const surfaceRows = pricedSurfaces.map((s, i) => ({
    quote_id: quoteId,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
    notes: emptyToNull(s.notes),
    line_item_id: lineItemData?.[i]?.id ?? null,
  }));

  const { error: surfErr } = await supabase.from('quote_surfaces').insert(surfaceRows);

  if (surfErr) {
    // Clean up the quote if surfaces failed.
    await supabase.from('quotes').delete().eq('id', quoteId);
    return { ok: false, error: `Failed to save surfaces: ${surfErr.message}` };
  }

  revalidatePath('/quotes');
  revalidatePath(`/contacts/${parsed.data.customer_id}`);
  return { ok: true, id: quoteId };
}

export async function updateQuoteAction(input: unknown): Promise<QuoteActionResult> {
  const parsed = quoteUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  // Load catalog for server-side pricing.
  const { data: catalogData } = await supabase
    .from('service_catalog')
    .select('surface_type, price_per_sqft_cents, min_charge_cents')
    .eq('is_active', true);

  const catalog = (catalogData ?? []) as CatalogEntryRow[];
  const catalogMap = new Map(catalog.map((c) => [c.surface_type, c]));

  const pricedSurfaces = parsed.data.surfaces.map((s) => {
    const entry = catalogMap.get(s.surface_type);
    const price_cents = entry
      ? calculateSurfacePrice({ surface_type: s.surface_type, sqft: s.sqft }, entry)
      : s.price_cents;
    return { ...s, price_cents };
  });

  const totals = calculateQuoteTotal(pricedSurfaces, TAX_RATE);

  // Update quote row.
  const { error: quoteErr } = await supabase
    .from('quotes')
    .update({
      customer_id: parsed.data.customer_id,
      subtotal_cents: totals.subtotal_cents,
      tax_cents: totals.tax_cents,
      total_cents: totals.total_cents,
      notes: emptyToNull(parsed.data.notes),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .is('deleted_at', null);

  if (quoteErr) {
    return { ok: false, error: quoteErr.message };
  }

  // Replace line items and surfaces: delete old, insert new.
  await supabase.from('quote_line_items').delete().eq('quote_id', parsed.data.id);
  await supabase.from('quote_surfaces').delete().eq('quote_id', parsed.data.id);

  const lineItemRows = buildLineItemRows(parsed.data.id, pricedSurfaces);
  const { data: lineItemData, error: liErr } = await supabase
    .from('quote_line_items')
    .insert(lineItemRows)
    .select('id');

  if (liErr) {
    return { ok: false, error: `Failed to update line items: ${liErr.message}` };
  }

  const surfaceRows = pricedSurfaces.map((s, i) => ({
    quote_id: parsed.data.id,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
    notes: emptyToNull(s.notes),
    line_item_id: lineItemData?.[i]?.id ?? null,
  }));

  const { error: surfErr } = await supabase.from('quote_surfaces').insert(surfaceRows);

  if (surfErr) {
    return { ok: false, error: `Failed to update surfaces: ${surfErr.message}` };
  }

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${parsed.data.id}`);
  revalidatePath(`/contacts/${parsed.data.customer_id}`);
  return { ok: true, id: parsed.data.id };
}

export async function sendQuoteAction(input: { quoteId: string }): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  // Load quote and tenant data (needed for PDF and email).
  const { getQuote } = await import('@/lib/db/queries/quotes');
  const quote = await getQuote(input.quoteId);
  if (!quote) {
    return { ok: false, error: 'Quote not found.' };
  }

  const { data: tenantData } = await supabase
    .from('tenants')
    .select(
      'id, name, slug, quote_validity_days, address_line1, address_line2, city, province, postal_code, phone, contact_email, website_url, logo_storage_path, gst_number, wcb_number',
    )
    .eq('id', tenant.id)
    .single();

  // Pre-fetch the logo as a data URL so jsPDF can embed it. Best-effort.
  let logoDataUrl: string | null = null;
  const logoPath = (tenantData?.logo_storage_path as string | null) ?? null;
  if (logoPath) {
    try {
      const { data: signed } = await supabase.storage
        .from('photos')
        .createSignedUrl(logoPath, 60 * 5);
      if (signed?.signedUrl) {
        const res = await fetch(signed.signedUrl);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          const contentType = res.headers.get('content-type') ?? 'image/png';
          // jsPDF only handles PNG / JPEG reliably.
          if (contentType === 'image/png' || contentType === 'image/jpeg') {
            logoDataUrl = `data:${contentType};base64,${buf.toString('base64')}`;
          }
        }
      }
    } catch {
      // swallow — PDF still generates without logo
    }
  }

  // Generate PDF.
  let pdfUrl: string | null = null;
  try {
    const { generateQuotePdf } = await import('@/lib/pdf/quote-pdf');

    const pdfBuffer = await generateQuotePdf(
      quote,
      {
        id: tenant.id,
        name: tenantData?.name ?? tenant.name,
        addressLine1: (tenantData?.address_line1 as string | null) ?? null,
        addressLine2: (tenantData?.address_line2 as string | null) ?? null,
        city: (tenantData?.city as string | null) ?? null,
        province: (tenantData?.province as string | null) ?? null,
        postalCode: (tenantData?.postal_code as string | null) ?? null,
        phone: (tenantData?.phone as string | null) ?? null,
        contactEmail: (tenantData?.contact_email as string | null) ?? null,
        websiteUrl: (tenantData?.website_url as string | null) ?? null,
        gstNumber: (tenantData?.gst_number as string | null) ?? null,
        wcbNumber: (tenantData?.wcb_number as string | null) ?? null,
        logoDataUrl,
      },
      quote.customer ?? {
        id: '',
        name: 'Customer',
        email: null,
        phone: null,
        address_line1: null,
        city: null,
        province: null,
        postal_code: null,
      },
    );

    // Upload to Supabase Storage.
    const path = `quotes/${tenant.id}/${input.quoteId}.pdf`;
    const { error: uploadErr } = await supabase.storage.from('quotes').upload(path, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: true,
    });

    if (!uploadErr) {
      const { data: urlData } = supabase.storage.from('quotes').getPublicUrl(path);
      pdfUrl = urlData?.publicUrl ?? null;
    }
  } catch {
    // PDF generation is best-effort. Log but don't block the send.
    console.error('PDF generation failed, continuing with send.');
  }

  // Update quote status.
  // If re-sending (status is already sent/accepted/rejected), keep the current
  // status but update sent_at and PDF. Only transition to 'sent' from 'draft'.
  const currentStatus = quote.status as string;
  const isResend = ['sent', 'accepted', 'rejected'].includes(currentStatus);
  const newStatus = isResend ? currentStatus : 'sent';

  // Generate approval code on first send (draft → sent).
  const approvalCode = isResend ? undefined : generateApprovalCode();

  const { error } = await supabase
    .from('quotes')
    .update({
      status: newStatus,
      sent_at: now,
      pdf_url: pdfUrl,
      updated_at: now,
      ...(approvalCode ? { approval_code: approvalCode } : {}),
    })
    .eq('id', input.quoteId)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: `Failed to send quote: ${error.message}` };
  }

  // Load tenant validity setting for the email template.
  const validityDays: number =
    (tenantData as Record<string, unknown> | null)?.quote_validity_days != null
      ? Number((tenantData as Record<string, unknown>).quote_validity_days)
      : 30;

  // Email the quote to the customer.
  let warning: string | undefined;
  const customer = quote.customer;
  let emailSent = false;

  if (customer?.email) {
    try {
      const { sendEmail } = await import('@/lib/email/send');
      const { quoteEmailHtml } = await import('@/lib/email/templates/quote-email');
      const { getEmailBrandingForTenant } = await import('@/lib/email/branding');

      const viewUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io'}/view/${input.quoteId}`;

      const branding = await getEmailBrandingForTenant(tenant.id);
      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: customer.email,
        subject: `Estimate from ${branding.businessName}`,
        html: quoteEmailHtml({
          customerName: customer.name,
          businessName: branding.businessName,
          logoUrl: branding.logoUrl,
          quoteNumber: input.quoteId.slice(0, 8),
          totalFormatted: formatCurrency(quote.total_cents),
          viewUrl,
          validityDays,
        }),
        caslCategory: 'transactional',
        relatedType: 'estimate',
        relatedId: input.quoteId,
        caslEvidence: { kind: 'estimate_send', quoteId: input.quoteId },
      });

      if (emailResult.ok) {
        emailSent = true;
      } else {
        console.error('Quote email failed:', emailResult.error);
      }
    } catch (emailErr) {
      console.error('Quote email error:', emailErr);
    }
  } else {
    warning = 'Customer has no email on file. Quote saved but not emailed.';
  }

  // Single worklog entry (merged "sent" + "emailed").
  const quoteShortId = input.quoteId.slice(0, 8);
  const worklogBody = emailSent
    ? `Quote #${quoteShortId} sent via email to ${customer?.email}`
    : `Quote #${quoteShortId} marked as sent (no email on file)`;

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: isResend ? 'Quote resent' : 'Quote sent',
    body: worklogBody,
    related_type: 'quote',
    related_id: input.quoteId,
  });

  // Quote follow-up autopilot — same logic as estimate-approval flow.
  if (emailSent && customer?.email) {
    try {
      const perQuoteFollowup =
        ((quote as Record<string, unknown>).auto_followup_enabled as boolean | null) ?? null;
      const enroll = await shouldEnrollQuoteFollowup({
        tenantId: tenant.id,
        perQuoteOverride: perQuoteFollowup,
      });
      if (enroll) {
        await ensureQuoteFollowupSequence(tenant.id);
        const [firstName, ...rest] = (customer.name ?? 'there').split(' ');
        await emitArEvent({
          tenantId: tenant.id,
          eventType: 'quote_sent',
          payload: {
            quote_id: input.quoteId,
            total_cents: quote.total_cents,
            from_name: tenant.name,
          },
          contact: {
            email: customer.email,
            phone: customer.phone ?? null,
            firstName: firstName ?? null,
            lastName: rest.join(' ') || null,
          },
        });
      }
    } catch (err) {
      console.error('[autopilot] quote_sent enrollment failed:', err);
    }
  }

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${input.quoteId}`);
  return { ok: true, id: input.quoteId, warning };
}

export async function acceptQuoteAction(input: { quoteId: string }): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('quotes')
    .update({
      status: 'accepted',
      accepted_at: now,
      updated_at: now,
    })
    .eq('id', input.quoteId)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: `Failed to accept quote: ${error.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Quote accepted',
    body: `Quote #${input.quoteId.slice(0, 8)} accepted by customer.`,
    related_type: 'quote',
    related_id: input.quoteId,
  });

  // Henry suggestion: seed tasks from the quote's scope buckets.
  const { onQuoteApproved } = await import('@/server/ai/triggers');
  await onQuoteApproved(input.quoteId);

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${input.quoteId}`);
  return { ok: true, id: input.quoteId };
}

export async function rejectQuoteAction(input: { quoteId: string }): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('quotes')
    .update({
      status: 'rejected',
      updated_at: now,
    })
    .eq('id', input.quoteId)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: `Failed to reject quote: ${error.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Quote rejected',
    body: `Quote #${input.quoteId.slice(0, 8)} marked as rejected.`,
    related_type: 'quote',
    related_id: input.quoteId,
  });

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${input.quoteId}`);
  return { ok: true, id: input.quoteId };
}

export async function deleteQuoteAction(id: string): Promise<QuoteActionResult | never> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing quote id.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('quotes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/quotes');
  redirect('/quotes');
}

export async function convertQuoteToJobAction(input: {
  quoteId: string;
}): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load the quote to get customer_id.
  const { data: quote, error: loadErr } = await supabase
    .from('quotes')
    .select('id, customer_id, status')
    .eq('id', input.quoteId)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr || !quote) {
    return { ok: false, error: 'Quote not found.' };
  }

  if (quote.status !== 'accepted') {
    return { ok: false, error: 'Only accepted quotes can be converted to jobs.' };
  }

  // Create the job using direct insert (not importing createJobAction to avoid
  // circular dependency issues; the job action does extra validation we don't need).
  const { data: jobData, error: jobErr } = await supabase
    .from('jobs')
    .insert({
      tenant_id: tenant.id,
      customer_id: quote.customer_id,
      quote_id: quote.id,
      status: 'booked',
      notes: `Job from Quote #${quote.id.slice(0, 8)}`,
    })
    .select('id')
    .single();

  if (jobErr || !jobData) {
    return { ok: false, error: jobErr?.message ?? 'Failed to create job.' };
  }

  // Worklog entry on the quote.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Quote converted to job',
    body: `Quote #${quote.id.slice(0, 8)} converted to Job #${jobData.id.slice(0, 8)}.`,
    related_type: 'quote',
    related_id: quote.id,
  });

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath('/jobs');
  return { ok: true, id: jobData.id };
}

/**
 * Convert an accepted quote to a project (GC/renovation vertical).
 * Creates a project with default cost buckets and links the quote.
 */
export async function convertQuoteToProjectAction(input: {
  quoteId: string;
}): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: quote, error: loadErr } = await supabase
    .from('quotes')
    .select('id, customer_id, status, notes, customers:customer_id (id, name)')
    .eq('id', input.quoteId)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadErr || !quote) return { ok: false, error: 'Quote not found.' };
  if (quote.status !== 'accepted')
    return { ok: false, error: 'Only accepted quotes can be converted to projects.' };

  const customerRaw = Array.isArray(quote.customers) ? quote.customers[0] : quote.customers;
  const customerName =
    customerRaw && typeof customerRaw === 'object' && 'name' in customerRaw
      ? (customerRaw as { name: string }).name
      : 'Project';

  const { data: projectData, error: projErr } = await supabase
    .from('projects')
    .insert({
      tenant_id: tenant.id,
      customer_id: quote.customer_id,
      quote_id: quote.id,
      name: `${customerName} — Renovation`,
      description: quote.notes || null,
      management_fee_rate: 0.12,
    })
    .select('id')
    .single();

  if (projErr || !projectData)
    return { ok: false, error: projErr?.message ?? 'Failed to create project.' };

  const DEFAULT_BUCKETS = [
    { name: 'Demo', section: 'general' },
    { name: 'Disposal', section: 'general' },
    { name: 'Framing', section: 'interior' },
    { name: 'Plumbing', section: 'interior' },
    { name: 'Electrical', section: 'interior' },
    { name: 'Drywall', section: 'interior' },
    { name: 'Flooring', section: 'interior' },
    { name: 'Painting', section: 'interior' },
    { name: 'Contingency', section: 'general' },
  ];

  await supabase.from('project_cost_buckets').insert(
    DEFAULT_BUCKETS.map((b, i) => ({
      project_id: projectData.id,
      tenant_id: tenant.id,
      name: b.name,
      section: b.section,
      display_order: i,
    })),
  );

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Quote converted to project',
    body: `Quote #${quote.id.slice(0, 8)} converted to project.`,
    related_type: 'quote',
    related_id: quote.id,
  });

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${quote.id}`);
  revalidatePath('/projects');
  return { ok: true, id: projectData.id };
}

/**
 * Duplicate a quote. Creates a new draft quote with the same customer and
 * surfaces.
 */
export async function duplicateQuoteAction(input: { quoteId: string }): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  // Load original quote.
  const { data: quote, error: qErr } = await supabase
    .from('quotes')
    .select('customer_id, subtotal_cents, tax_cents, total_cents, notes')
    .eq('id', input.quoteId)
    .is('deleted_at', null)
    .maybeSingle();

  if (qErr || !quote) return { ok: false, error: 'Quote not found.' };

  // Load surfaces.
  const { data: surfaces } = await supabase
    .from('quote_surfaces')
    .select('surface_type, polygon_geojson, sqft, price_cents, notes')
    .eq('quote_id', input.quoteId)
    .order('created_at', { ascending: true });

  // Insert new quote as draft.
  const { data: newQuote, error: insertErr } = await supabase
    .from('quotes')
    .insert({
      tenant_id: tenant.id,
      customer_id: quote.customer_id,
      status: 'draft',
      subtotal_cents: quote.subtotal_cents,
      tax_cents: quote.tax_cents,
      total_cents: quote.total_cents,
      notes: quote.notes,
    })
    .select('id')
    .single();

  if (insertErr || !newQuote)
    return { ok: false, error: insertErr?.message ?? 'Failed to duplicate quote.' };

  // Copy line items and surfaces.
  if (surfaces && surfaces.length > 0) {
    const pricedSurfaces = surfaces as {
      surface_type: string;
      sqft: number;
      price_cents: number;
    }[];
    const lineItemRows = buildLineItemRows(newQuote.id, pricedSurfaces);
    const { data: lineItemData } = await supabase
      .from('quote_line_items')
      .insert(lineItemRows)
      .select('id');

    const surfaceRows = surfaces.map((s, i) => ({
      quote_id: newQuote.id,
      surface_type: s.surface_type,
      polygon_geojson: s.polygon_geojson,
      sqft: s.sqft,
      price_cents: s.price_cents,
      notes: s.notes,
      line_item_id: lineItemData?.[i]?.id ?? null,
    }));
    await supabase.from('quote_surfaces').insert(surfaceRows);
  }

  revalidatePath('/quotes');
  return { ok: true, id: newQuote.id };
}

export async function upsertCatalogEntryAction(input: {
  id?: string;
  surface_type: string;
  label: string;
  price_per_sqft_cents: number;
  min_charge_cents: number;
  is_active?: boolean;
}): Promise<QuoteActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  if (!input.surface_type.trim() || !input.label.trim()) {
    return { ok: false, error: 'Surface type and label are required.' };
  }

  const supabase = await createClient();

  if (input.id) {
    // Update existing.
    const { error } = await supabase
      .from('service_catalog')
      .update({
        surface_type: input.surface_type.trim(),
        label: input.label.trim(),
        price_per_sqft_cents: input.price_per_sqft_cents,
        min_charge_cents: input.min_charge_cents,
        is_active: input.is_active ?? true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', input.id);

    if (error) {
      return { ok: false, error: error.message };
    }

    revalidatePath('/settings/catalog');
    revalidatePath('/settings');
    return { ok: true, id: input.id };
  }

  // Insert new.
  const { data, error } = await supabase
    .from('service_catalog')
    .insert({
      tenant_id: tenant.id,
      surface_type: input.surface_type.trim(),
      label: input.label.trim(),
      price_per_sqft_cents: input.price_per_sqft_cents,
      min_charge_cents: input.min_charge_cents,
      is_active: input.is_active ?? true,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create catalog entry.' };
  }

  revalidatePath('/settings/catalog');
  revalidatePath('/settings');
  return { ok: true, id: data.id };
}

// ---------------------------------------------------------------------------
// PUBLIC actions — no auth required, use admin client
// ---------------------------------------------------------------------------

export type QuotePublicActionResult = { ok: true } | { ok: false; error: string };

/**
 * PUBLIC action: customer accepts a quote from the public view page.
 * No auth required. Uses admin client.
 */
export async function approveQuotePublicAction(
  quoteId: string,
  approvedByName: string,
): Promise<QuotePublicActionResult> {
  const name = approvedByName?.trim();
  if (!name) {
    return { ok: false, error: 'Please type your name to accept.' };
  }

  const admin = createAdminClient();

  // Load quote with customer and tenant info.
  const { data: quote, error: qErr } = await admin
    .from('quotes')
    .select('id, tenant_id, customer_id, status, total_cents')
    .eq('id', quoteId)
    .is('deleted_at', null)
    .maybeSingle();

  if (qErr || !quote) {
    return { ok: false, error: 'Estimate not found.' };
  }

  if ((quote.status as string) !== 'sent') {
    return {
      ok: false,
      error: 'This estimate has already been responded to or is no longer available.',
    };
  }

  const now = new Date().toISOString();
  const tenantId = quote.tenant_id as string;
  const quoteShortId = quoteId.slice(0, 8);

  // Update status.
  const { error: updateErr } = await admin
    .from('quotes')
    .update({
      status: 'accepted',
      accepted_at: now,
      updated_at: now,
    })
    .eq('id', quoteId);

  if (updateErr) {
    return { ok: false, error: `Failed to accept estimate: ${updateErr.message}` };
  }

  // Load customer name for notifications.
  const { data: customer } = await admin
    .from('customers')
    .select('name')
    .eq('id', quote.customer_id as string)
    .single();

  const customerName = (customer?.name as string) ?? 'Customer';
  const totalFormatted = formatCurrency(quote.total_cents as number);

  // Worklog entry.
  await admin.from('worklog_entries').insert({
    tenant_id: tenantId,
    entry_type: 'system',
    title: 'Estimate accepted',
    body: `Estimate #${quoteShortId} accepted by ${name}.`,
    related_type: 'quote',
    related_id: quoteId,
  });

  // Get operator info for notification email and todo.
  const { data: memberData } = await admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .maybeSingle();

  if (memberData?.user_id) {
    const userId = memberData.user_id as string;

    // Create a todo for the operator.
    await admin.from('todos').insert({
      tenant_id: tenantId,
      user_id: userId,
      title: `Schedule job for ${customerName} — estimate accepted (${totalFormatted})`,
      related_type: 'quote',
      related_id: quoteId,
    });

    // Send notification email to operator.
    const { data: userData } = await admin.auth.admin.getUserById(userId);
    const operatorEmail = userData?.user?.email;

    if (operatorEmail) {
      try {
        const { sendEmail } = await import('@/lib/email/send');
        const { quoteResponseEmailHtml } = await import('@/lib/email/templates/quote-response');

        // MUST be app.heyhenry.io (not heyhenry.io — that's the marketing site).
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';

        await sendEmail({
          tenantId,
          to: operatorEmail,
          subject: `${customerName} accepted your estimate!`,
          html: quoteResponseEmailHtml({
            type: 'accepted',
            customerName,
            quoteNumber: quoteShortId,
            totalFormatted,
            viewUrl: `${appUrl}/quotes/${quoteId}`,
          }),
          caslCategory: 'transactional',
          relatedType: 'estimate',
          relatedId: quoteId,
          caslEvidence: { kind: 'estimate_accepted_internal', quoteId },
        });
      } catch (e) {
        console.error('Failed to send quote acceptance email:', e);
      }
    }
  }

  // Henry suggestion: seed tasks from quote scope buckets.
  const { onQuoteApproved } = await import('@/server/ai/triggers');
  await onQuoteApproved(quoteId);

  return { ok: true };
}

/**
 * PUBLIC action: customer declines a quote from the public view page.
 * No auth required. Uses admin client.
 */
export async function declineQuotePublicAction(
  quoteId: string,
  reason?: string,
): Promise<QuotePublicActionResult> {
  const admin = createAdminClient();

  // Load quote.
  const { data: quote, error: qErr } = await admin
    .from('quotes')
    .select('id, tenant_id, customer_id, status, total_cents')
    .eq('id', quoteId)
    .is('deleted_at', null)
    .maybeSingle();

  if (qErr || !quote) {
    return { ok: false, error: 'Estimate not found.' };
  }

  if ((quote.status as string) !== 'sent') {
    return {
      ok: false,
      error: 'This estimate has already been responded to or is no longer available.',
    };
  }

  const now = new Date().toISOString();
  const tenantId = quote.tenant_id as string;
  const quoteShortId = quoteId.slice(0, 8);
  const trimmedReason = reason?.trim() || undefined;

  // Update status.
  const { error: updateErr } = await admin
    .from('quotes')
    .update({
      status: 'rejected',
      updated_at: now,
    })
    .eq('id', quoteId);

  if (updateErr) {
    return { ok: false, error: `Failed to decline estimate: ${updateErr.message}` };
  }

  // Load customer name.
  const { data: customer } = await admin
    .from('customers')
    .select('name')
    .eq('id', quote.customer_id as string)
    .single();

  const customerName = (customer?.name as string) ?? 'Customer';

  // Worklog entry.
  await admin.from('worklog_entries').insert({
    tenant_id: tenantId,
    entry_type: 'system',
    title: 'Estimate declined',
    body: `Estimate #${quoteShortId} declined by customer.${trimmedReason ? ` Reason: ${trimmedReason}` : ''}`,
    related_type: 'quote',
    related_id: quoteId,
  });

  // Notify operator via email.
  const { data: memberData } = await admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('role', 'owner')
    .maybeSingle();

  if (memberData?.user_id) {
    const { data: userData } = await admin.auth.admin.getUserById(memberData.user_id as string);
    const operatorEmail = userData?.user?.email;

    if (operatorEmail) {
      try {
        const { sendEmail } = await import('@/lib/email/send');
        const { quoteResponseEmailHtml } = await import('@/lib/email/templates/quote-response');

        // MUST be app.heyhenry.io (not heyhenry.io — that's the marketing site).
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';

        await sendEmail({
          tenantId,
          to: operatorEmail,
          subject: `Estimate declined — ${customerName}`,
          html: quoteResponseEmailHtml({
            type: 'declined',
            customerName,
            quoteNumber: quoteShortId,
            totalFormatted: formatCurrency(quote.total_cents as number),
            reason: trimmedReason,
            viewUrl: `${appUrl}/quotes/${quoteId}`,
          }),
          caslCategory: 'transactional',
          relatedType: 'estimate',
          relatedId: quoteId,
          caslEvidence: { kind: 'estimate_declined_internal', quoteId },
        });
      } catch (e) {
        console.error('Failed to send quote decline email:', e);
      }
    }
  }

  return { ok: true };
}
