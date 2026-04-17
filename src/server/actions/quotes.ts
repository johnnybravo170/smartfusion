'use server';

/**
 * Server actions for the Quotes module.
 *
 * All mutations run through the RLS-aware server client. The tenant check
 * happens in the database. We resolve the tenant via `getCurrentTenant`
 * because INSERT needs an explicit `tenant_id`.
 */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { getCurrentTenant } from '@/lib/auth/helpers';
import type { CatalogEntryRow } from '@/lib/db/queries/service-catalog';
import {
  calculateQuoteTotal,
  calculateSurfacePrice,
  formatCurrency,
} from '@/lib/pricing/calculator';
import { createClient } from '@/lib/supabase/server';
import { emptyToNull, quoteCreateSchema, quoteUpdateSchema } from '@/lib/validators/quote';

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

  // Insert surfaces.
  const surfaceRows = pricedSurfaces.map((s) => ({
    quote_id: quoteId,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
    notes: emptyToNull(s.notes),
  }));

  const { error: surfErr } = await supabase.from('quote_surfaces').insert(surfaceRows);

  if (surfErr) {
    // Clean up the quote if surfaces failed.
    await supabase.from('quotes').delete().eq('id', quoteId);
    return { ok: false, error: `Failed to save surfaces: ${surfErr.message}` };
  }

  revalidatePath('/quotes');
  revalidatePath(`/customers/${parsed.data.customer_id}`);
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

  // Replace surfaces: delete old, insert new.
  await supabase.from('quote_surfaces').delete().eq('quote_id', parsed.data.id);

  const surfaceRows = pricedSurfaces.map((s) => ({
    quote_id: parsed.data.id,
    surface_type: s.surface_type,
    polygon_geojson: s.polygon_geojson ?? null,
    sqft: s.sqft,
    price_cents: s.price_cents,
    notes: emptyToNull(s.notes),
  }));

  const { error: surfErr } = await supabase.from('quote_surfaces').insert(surfaceRows);

  if (surfErr) {
    return { ok: false, error: `Failed to update surfaces: ${surfErr.message}` };
  }

  revalidatePath('/quotes');
  revalidatePath(`/quotes/${parsed.data.id}`);
  revalidatePath(`/customers/${parsed.data.customer_id}`);
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
    .select('id, name, slug')
    .eq('id', tenant.id)
    .single();

  // Generate PDF.
  let pdfUrl: string | null = null;
  try {
    const { generateQuotePdf } = await import('@/lib/pdf/quote-pdf');

    const pdfBuffer = await generateQuotePdf(
      quote,
      {
        name: tenantData?.name ?? tenant.name,
        id: tenant.id,
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

  const { error } = await supabase
    .from('quotes')
    .update({
      status: newStatus,
      sent_at: now,
      pdf_url: pdfUrl,
      updated_at: now,
    })
    .eq('id', input.quoteId)
    .is('deleted_at', null);

  if (error) {
    return { ok: false, error: `Failed to send quote: ${error.message}` };
  }

  // Worklog entry.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: isResend ? 'Quote resent' : 'Quote sent',
    body: `Quote #${input.quoteId.slice(0, 8)} ${isResend ? 'resent' : 'marked as sent'}.`,
    related_type: 'quote',
    related_id: input.quoteId,
  });

  // Email the quote to the customer.
  let warning: string | undefined;
  const customer = quote.customer;

  if (customer?.email) {
    try {
      const { sendEmail } = await import('@/lib/email/send');
      const { quoteEmailHtml } = await import('@/lib/email/templates/quote-email');

      // Use a signed PDF URL so the customer can download directly (no login).
      // Falls back to the app URL if PDF wasn't generated.
      let viewUrl = `${process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io'}/quotes/${input.quoteId}`;
      if (pdfUrl) {
        const pdfPath = `quotes/${tenant.id}/${input.quoteId}.pdf`;
        const { data: signedData } = await supabase.storage
          .from('quotes')
          .createSignedUrl(pdfPath, 60 * 60 * 24 * 30); // 30 days
        if (signedData?.signedUrl) {
          viewUrl = signedData.signedUrl;
        }
      }

      const emailResult = await sendEmail({
        to: customer.email,
        subject: `Quote from ${tenantData?.name ?? tenant.name}`,
        html: quoteEmailHtml({
          customerName: customer.name,
          businessName: tenantData?.name ?? tenant.name,
          quoteNumber: input.quoteId.slice(0, 8),
          totalFormatted: formatCurrency(quote.total_cents),
          viewUrl,
        }),
      });

      if (emailResult.ok) {
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Quote emailed',
          body: `Quote #${input.quoteId.slice(0, 8)} emailed to ${customer.email}`,
          related_type: 'quote',
          related_id: input.quoteId,
        });
      } else {
        console.error('Quote email failed:', emailResult.error);
      }
    } catch (emailErr) {
      console.error('Quote email error:', emailErr);
    }
  } else {
    warning = 'Customer has no email on file. Quote saved but not emailed.';
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
