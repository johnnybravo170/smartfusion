'use server';

/**
 * Server actions for the Invoices module.
 *
 * Flow: job is complete -> "Generate Invoice" creates a draft row ->
 * "Send Invoice" creates a Stripe Checkout Session on the connected
 * account with a 0.5% application fee -> webhook marks as paid.
 *
 * See PHASE_1_PLAN.md Phase 1C.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import type { InvoiceLineItem } from '@/lib/db/queries/invoices';
import { formatCurrency } from '@/lib/pricing/calculator';
import { getStripe } from '@/lib/stripe/client';
import { createClient } from '@/lib/supabase/server';
import {
  canTransition,
  invoiceCreateSchema,
  invoiceMarkPaidSchema,
  invoiceSendSchema,
  invoiceVoidSchema,
} from '@/lib/validators/invoice';

export type InvoiceActionResult =
  | { ok: true; id?: string; paymentUrl?: string; warning?: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Create a draft invoice for a completed job. If the job has a linked quote,
 * we use the quote's total_cents as the invoice amount. Tax is 5% GST.
 */
export async function createInvoiceAction(input: { jobId: string }): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load the job with customer and optional quote.
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .select('id, status, customer_id, quote_id, quotes:quote_id (id, total_cents)')
    .eq('id', input.jobId)
    .is('deleted_at', null)
    .maybeSingle();

  if (jobErr || !job) {
    return { ok: false, error: jobErr?.message ?? 'Job not found.' };
  }

  if (job.status !== 'complete') {
    return { ok: false, error: 'Job must be complete before generating an invoice.' };
  }

  if (!job.customer_id) {
    return { ok: false, error: 'Job has no customer assigned.' };
  }

  // Check if an invoice already exists for this job.
  const { data: existing } = await supabase
    .from('invoices')
    .select('id')
    .eq('job_id', input.jobId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle();

  if (existing) {
    return { ok: false, error: 'An invoice already exists for this job.' };
  }

  // Determine amount from linked quote.
  const quoteRaw = Array.isArray(job.quotes) ? job.quotes[0] : job.quotes;
  const quoteTotalCents =
    quoteRaw && typeof quoteRaw === 'object' && 'total_cents' in quoteRaw
      ? (quoteRaw as { total_cents: number }).total_cents
      : null;

  if (!quoteTotalCents || quoteTotalCents <= 0) {
    return {
      ok: false,
      error:
        'No linked quote with a total found. Link a quote to the job first, or create the invoice manually in a future release.',
    };
  }

  // 5% GST.
  const amountCents = quoteTotalCents;
  const taxCents = Math.round(amountCents * 0.05);

  // Validate.
  const parsed = invoiceCreateSchema.safeParse({
    job_id: input.jobId,
    amount_cents: amountCents,
    tax_cents: taxCents,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Validation failed.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenant.id,
      job_id: parsed.data.job_id,
      customer_id: job.customer_id,
      status: 'draft',
      amount_cents: parsed.data.amount_cents,
      tax_cents: parsed.data.tax_cents,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create invoice.' };
  }

  // Worklog entry.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice created',
    body: `Draft invoice #${data.id.slice(0, 8)} created for $${(amountCents / 100).toFixed(2)} + $${(taxCents / 100).toFixed(2)} GST.`,
    related_type: 'job',
    related_id: input.jobId,
  });

  revalidatePath('/invoices');
  revalidatePath(`/jobs/${input.jobId}`);
  return { ok: true, id: data.id };
}

/**
 * Send an invoice by creating a Stripe Checkout Session on the operator's
 * connected account. Returns the checkout URL (payment link).
 */
export async function sendInvoiceAction(input: {
  invoiceId: string;
}): Promise<InvoiceActionResult> {
  const parsed = invoiceSendSchema.safeParse({ invoice_id: input.invoiceId });
  if (!parsed.success) {
    return { ok: false, error: 'Invalid invoice id.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load invoice.
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, amount_cents, tax_cents, line_items, customer_note, job_id, customer_id')
    .eq('id', parsed.data.invoice_id)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) {
    return { ok: false, error: invErr?.message ?? 'Invoice not found.' };
  }

  if (!canTransition(invoice.status as 'draft', 'sent')) {
    return { ok: false, error: `Cannot send an invoice with status "${invoice.status}".` };
  }

  // Load tenant for stripe_account_id.
  const { data: tenantRow } = await supabase
    .from('tenants')
    .select('stripe_account_id, name')
    .eq('id', tenant.id)
    .single();

  const stripeAccountId = tenantRow?.stripe_account_id as string | null;

  // Load customer for the checkout line item and email.
  const { data: customer } = await supabase
    .from('customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .single();

  const invoiceLineItems = ((invoice.line_items as InvoiceLineItem[] | null) ??
    []) as InvoiceLineItem[];
  const lineItemsTotal = invoiceLineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const totalCents = invoice.amount_cents + lineItemsTotal + invoice.tax_cents;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const publicViewUrl = `${appUrl}/view/invoice/${invoice.id}`;

  let paymentUrl: string | undefined;
  let stripeSessionId: string | null = null;

  if (stripeAccountId) {
    // Create a Stripe Checkout Session on the connected account.
    const appFeeCents = Math.round(totalCents * 0.005); // 0.5% platform fee

    const session = await getStripe().checkout.sessions.create(
      {
        line_items: [
          {
            price_data: {
              currency: 'cad',
              unit_amount: totalCents,
              product_data: {
                name: `Invoice from ${tenantRow?.name ?? 'your contractor'}`,
                description: customer?.name
                  ? `Service for ${customer.name}`
                  : 'Contractor services',
              },
            },
            quantity: 1,
          },
        ],
        mode: 'payment',
        payment_intent_data: {
          application_fee_amount: appFeeCents,
        },
        success_url: `${appUrl}/invoices/${invoice.id}?payment=success`,
        cancel_url: `${appUrl}/invoices/${invoice.id}?payment=cancelled`,
        metadata: {
          invoice_id: invoice.id,
          tenant_id: tenant.id,
        },
      },
      { stripeAccount: stripeAccountId },
    );

    paymentUrl = session.url ?? undefined;
    stripeSessionId = session.id;
  }

  // Update invoice row.
  // stripe_invoice_id stores checkout session ID; pdf_url stores the payment link.
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({
      status: 'sent',
      stripe_invoice_id: stripeSessionId,
      pdf_url: paymentUrl ?? null,
      sent_at: now,
      updated_at: now,
    })
    .eq('id', invoice.id);

  if (updateErr) {
    return {
      ok: false,
      error: `Invoice update failed: ${updateErr.message}`,
    };
  }

  // Worklog entry.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice sent',
    body: stripeAccountId
      ? `Invoice #${invoice.id.slice(0, 8)} sent. Payment link created.`
      : `Invoice #${invoice.id.slice(0, 8)} sent (no Stripe, email-only).`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  // Email the invoice to the customer.
  let warning: string | undefined;
  // Use payment URL if Stripe is connected, otherwise link to public view page.
  const emailLinkUrl = paymentUrl ?? publicViewUrl;

  if (customer?.email) {
    try {
      const { sendEmail } = await import('@/lib/email/send');
      const { invoiceEmailHtml } = await import('@/lib/email/templates/invoice-email');

      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: customer.email,
        subject: `Invoice from ${tenantRow?.name ?? 'your contractor'} — ${formatCurrency(totalCents)}`,
        html: invoiceEmailHtml({
          customerName: customer.name,
          businessName: tenantRow?.name ?? 'your contractor',
          invoiceNumber: invoice.id.slice(0, 8),
          totalFormatted: formatCurrency(totalCents),
          payUrl: emailLinkUrl,
          customerNote: (invoice.customer_note as string | null) ?? undefined,
          hasStripe: !!stripeAccountId,
        }),
      });

      if (emailResult.ok) {
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Invoice emailed',
          body: `Invoice #${invoice.id.slice(0, 8)} emailed to ${customer.email}`,
          related_type: 'job',
          related_id: invoice.job_id,
        });
      } else {
        console.error('Invoice email failed:', emailResult.error);
      }
    } catch (emailErr) {
      console.error('Invoice email error:', emailErr);
    }
  } else {
    warning = 'Customer has no email on file. Invoice saved but not emailed.';
  }

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath(`/jobs/${invoice.job_id}`);
  return { ok: true, id: invoice.id, paymentUrl, warning };
}

/**
 * Resend an already-sent invoice. Re-sends the email with the existing payment
 * link. Does NOT create a new Stripe Checkout session.
 */
export async function resendInvoiceAction(input: {
  invoiceId: string;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Load invoice.
  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select(
      'id, status, amount_cents, tax_cents, line_items, customer_note, job_id, customer_id, pdf_url',
    )
    .eq('id', input.invoiceId)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) {
    return { ok: false, error: invErr?.message ?? 'Invoice not found.' };
  }

  if (invoice.status !== 'sent') {
    return { ok: false, error: `Can only resend invoices with status "sent".` };
  }

  const paymentUrl = invoice.pdf_url;
  if (!paymentUrl) {
    return { ok: false, error: 'No payment link found. Send the invoice first.' };
  }

  // Load tenant name for email.
  const { data: tenantRow } = await supabase
    .from('tenants')
    .select('name')
    .eq('id', tenant.id)
    .single();

  // Load customer for email.
  const { data: customer } = await supabase
    .from('customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .single();

  const resendLineItems = ((invoice.line_items as InvoiceLineItem[] | null) ??
    []) as InvoiceLineItem[];
  const resendLineItemsTotal = resendLineItems.reduce((sum, li) => sum + li.total_cents, 0);
  const totalCents = invoice.amount_cents + resendLineItemsTotal + invoice.tax_cents;

  // Update sent_at timestamp.
  const now = new Date().toISOString();
  await supabase.from('invoices').update({ sent_at: now, updated_at: now }).eq('id', invoice.id);

  // Worklog entry.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice resent',
    body: `Invoice #${invoice.id.slice(0, 8)} resent.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  // Email the payment link to the customer.
  let warning: string | undefined;

  if (customer?.email) {
    try {
      const { sendEmail } = await import('@/lib/email/send');
      const { invoiceEmailHtml } = await import('@/lib/email/templates/invoice-email');

      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: customer.email,
        subject: `Invoice from ${tenantRow?.name ?? 'your contractor'} — ${formatCurrency(totalCents)}`,
        html: invoiceEmailHtml({
          customerName: customer.name,
          businessName: tenantRow?.name ?? 'your contractor',
          invoiceNumber: invoice.id.slice(0, 8),
          totalFormatted: formatCurrency(totalCents),
          payUrl: paymentUrl,
          customerNote: (invoice.customer_note as string | null) ?? undefined,
        }),
      });

      if (emailResult.ok) {
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Invoice emailed',
          body: `Invoice #${invoice.id.slice(0, 8)} resent to ${customer.email}`,
          related_type: 'job',
          related_id: invoice.job_id,
        });
      } else {
        console.error('Invoice resend email failed:', emailResult.error);
      }
    } catch (emailErr) {
      console.error('Invoice resend email error:', emailErr);
    }
  } else {
    warning = 'Customer has no email on file. Invoice not emailed.';
  }

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath(`/jobs/${invoice.job_id}`);
  return { ok: true, id: invoice.id, paymentUrl, warning };
}

/**
 * Void an invoice. Terminal state.
 */
export async function voidInvoiceAction(input: {
  invoiceId: string;
}): Promise<InvoiceActionResult> {
  const parsed = invoiceVoidSchema.safeParse({ invoice_id: input.invoiceId });
  if (!parsed.success) {
    return { ok: false, error: 'Invalid invoice id.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, job_id')
    .eq('id', parsed.data.invoice_id)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) {
    return { ok: false, error: invErr?.message ?? 'Invoice not found.' };
  }

  if (!canTransition(invoice.status as 'draft' | 'sent', 'void')) {
    return { ok: false, error: `Cannot void an invoice with status "${invoice.status}".` };
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ status: 'void', updated_at: now })
    .eq('id', invoice.id);

  if (updateErr) {
    return { ok: false, error: `Failed to void invoice: ${updateErr.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice voided',
    body: `Invoice #${invoice.id.slice(0, 8)} has been voided.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath(`/jobs/${invoice.job_id}`);
  return { ok: true, id: invoice.id };
}

/**
 * Manually mark an invoice as paid (e.g. cash/e-transfer payment).
 */
export async function markInvoicePaidAction(input: {
  invoiceId: string;
  paymentMethod?: string;
}): Promise<InvoiceActionResult> {
  const parsed = invoiceMarkPaidSchema.safeParse({ invoice_id: input.invoiceId });
  if (!parsed.success) {
    return { ok: false, error: 'Invalid invoice id.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, job_id')
    .eq('id', parsed.data.invoice_id)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) {
    return { ok: false, error: invErr?.message ?? 'Invoice not found.' };
  }

  if (!canTransition(invoice.status as 'sent', 'paid')) {
    return { ok: false, error: `Cannot mark as paid from status "${invoice.status}".` };
  }

  const method = input.paymentMethod ?? 'other';
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: now, payment_method: method, updated_at: now })
    .eq('id', invoice.id);

  if (updateErr) {
    return { ok: false, error: `Failed to mark as paid: ${updateErr.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice paid',
    body: `Invoice #${invoice.id.slice(0, 8)} marked as paid via ${method}.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath(`/jobs/${invoice.job_id}`);
  return { ok: true, id: invoice.id };
}

/**
 * Duplicate an invoice. Creates a new draft copy with the same customer and
 * amounts. Clears sent_at, paid_at, and all Stripe fields. Best for recurring
 * work on paid/void invoices.
 */
export async function duplicateInvoiceAction(input: {
  invoiceId: string;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('job_id, customer_id, amount_cents, tax_cents, line_items, customer_note')
    .eq('id', input.invoiceId)
    .is('deleted_at', null)
    .maybeSingle();

  if (invErr || !invoice) return { ok: false, error: 'Invoice not found.' };

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenant.id,
      job_id: invoice.job_id,
      customer_id: invoice.customer_id,
      status: 'draft',
      amount_cents: invoice.amount_cents,
      tax_cents: invoice.tax_cents,
      line_items: invoice.line_items,
      customer_note: invoice.customer_note,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to duplicate invoice.' };

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice duplicated',
    body: `Duplicated from Invoice #${input.invoiceId.slice(0, 8)}.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  revalidatePath('/invoices');
  return { ok: true, id: data.id };
}

/**
 * Add a line item to an invoice. Recalculates tax on line items (5% GST).
 */
export async function addInvoiceLineItemAction(input: {
  invoiceId: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  if (!input.description.trim()) return { ok: false, error: 'Description is required.' };
  if (input.quantity < 1) return { ok: false, error: 'Quantity must be at least 1.' };
  if (input.unitPriceCents <= 0) return { ok: false, error: 'Unit price must be positive.' };

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, amount_cents, line_items, job_id')
    .eq('id', input.invoiceId)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) return { ok: false, error: 'Invoice not found.' };
  if (invoice.status !== 'draft') {
    return { ok: false, error: 'Can only add items to draft invoices.' };
  }

  const existingItems = ((invoice.line_items as InvoiceLineItem[] | null) ??
    []) as InvoiceLineItem[];
  const newItem: InvoiceLineItem = {
    description: input.description.trim(),
    quantity: input.quantity,
    unit_price_cents: input.unitPriceCents,
    total_cents: input.quantity * input.unitPriceCents,
  };

  const updatedItems = [...existingItems, newItem];
  const lineItemsTotal = updatedItems.reduce((sum, li) => sum + li.total_cents, 0);

  // Recalculate tax: 5% GST on (base amount + line items)
  const baseCents = invoice.amount_cents;
  const newTax = Math.round((baseCents + lineItemsTotal) * 0.05);

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ line_items: updatedItems, tax_cents: newTax, updated_at: now })
    .eq('id', input.invoiceId);

  if (updateErr) return { ok: false, error: `Failed to add line item: ${updateErr.message}` };

  revalidatePath(`/invoices/${input.invoiceId}`);
  return { ok: true, id: input.invoiceId };
}

/**
 * Remove a line item from an invoice by index. Recalculates tax.
 */
export async function removeInvoiceLineItemAction(input: {
  invoiceId: string;
  itemIndex: number;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status, amount_cents, line_items')
    .eq('id', input.invoiceId)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) return { ok: false, error: 'Invoice not found.' };
  if (invoice.status !== 'draft') {
    return { ok: false, error: 'Can only modify draft invoices.' };
  }

  const existingItems = ((invoice.line_items as InvoiceLineItem[] | null) ??
    []) as InvoiceLineItem[];
  if (input.itemIndex < 0 || input.itemIndex >= existingItems.length) {
    return { ok: false, error: 'Invalid item index.' };
  }

  const updatedItems = existingItems.filter((_, i) => i !== input.itemIndex);
  const lineItemsTotal = updatedItems.reduce((sum, li) => sum + li.total_cents, 0);
  const newTax = Math.round((invoice.amount_cents + lineItemsTotal) * 0.05);

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ line_items: updatedItems, tax_cents: newTax, updated_at: now })
    .eq('id', input.invoiceId);

  if (updateErr) return { ok: false, error: `Failed to remove line item: ${updateErr.message}` };

  revalidatePath(`/invoices/${input.invoiceId}`);
  return { ok: true, id: input.invoiceId };
}

/**
 * Update the personalized customer note on an invoice.
 */
export async function updateInvoiceNoteAction(input: {
  invoiceId: string;
  note: string;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: invoice, error: invErr } = await supabase
    .from('invoices')
    .select('id, status')
    .eq('id', input.invoiceId)
    .is('deleted_at', null)
    .single();

  if (invErr || !invoice) return { ok: false, error: 'Invoice not found.' };
  if (invoice.status !== 'draft') {
    return { ok: false, error: 'Can only edit notes on draft invoices.' };
  }

  const now = new Date().toISOString();
  const noteValue = input.note.trim() || null;
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ customer_note: noteValue, updated_at: now })
    .eq('id', input.invoiceId);

  if (updateErr) return { ok: false, error: `Failed to update note: ${updateErr.message}` };

  revalidatePath(`/invoices/${input.invoiceId}`);
  return { ok: true, id: input.invoiceId };
}

// ─── Project (GC) milestone invoice ──────────────────────────────────────────

export async function createMilestoneInvoiceAction(input: {
  projectId: string;
  label: string;
  lineItems: { description: string; quantity: number; unitPriceCents: number }[];
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };
  if (!input.label.trim()) return { ok: false, error: 'Milestone label is required.' };
  if (input.lineItems.length === 0) return { ok: false, error: 'At least one line item is required.' };

  const supabase = await createClient();

  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, customer_id, name')
    .eq('id', input.projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (projErr || !project) return { ok: false, error: 'Project not found.' };
  if (!project.customer_id) return { ok: false, error: 'Project has no customer assigned.' };

  const items: InvoiceLineItem[] = input.lineItems.map((li) => ({
    description: li.description.trim(),
    quantity: li.quantity,
    unit_price_cents: li.unitPriceCents,
    total_cents: li.quantity * li.unitPriceCents,
  }));
  const subtotalCents = items.reduce((s, li) => s + li.total_cents, 0);
  const taxCents = Math.round(subtotalCents * 0.05);

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenant.id,
      project_id: input.projectId,
      customer_id: project.customer_id,
      status: 'draft',
      amount_cents: subtotalCents,
      tax_cents: taxCents,
      line_items: items,
      customer_note: input.label,
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create invoice.' };

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Milestone invoice created',
    body: `Invoice "${input.label}" created for project "${project.name}".`,
    related_type: 'project',
    related_id: input.projectId,
  });

  revalidatePath(`/projects/${input.projectId}`);
  revalidatePath('/invoices');
  return { ok: true, id: data.id as string };
}

// ─── Project (GC) final invoice ───────────────────────────────────────────────

export async function generateFinalInvoiceAction(input: {
  projectId: string;
}): Promise<InvoiceActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in or missing tenant.' };

  const supabase = await createClient();

  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, customer_id, name, management_fee_rate')
    .eq('id', input.projectId)
    .is('deleted_at', null)
    .maybeSingle();

  if (projErr || !project) return { ok: false, error: 'Project not found.' };
  if (!project.customer_id) return { ok: false, error: 'Project has no customer assigned.' };

  const mgmtRate = (project.management_fee_rate as number) ?? 0.12;

  const [timeRes, expenseRes, priorInvoicesRes] = await Promise.all([
    supabase.from('time_entries').select('hours, hourly_rate_cents').eq('project_id', input.projectId),
    supabase.from('expenses').select('amount_cents').eq('project_id', input.projectId),
    supabase
      .from('invoices')
      .select('amount_cents')
      .eq('project_id', input.projectId)
      .not('status', 'in', '("void")')
      .is('deleted_at', null),
  ]);

  const timeEntries = (timeRes.data ?? []) as { hours: number; hourly_rate_cents: number | null }[];
  const expenses = (expenseRes.data ?? []) as { amount_cents: number }[];
  const priorInvoices = (priorInvoicesRes.data ?? []) as { amount_cents: number }[];

  const labourCents = timeEntries.reduce((s, t) => {
    const rate = t.hourly_rate_cents ?? 0;
    return s + Math.round(Number(t.hours) * rate);
  }, 0);
  const expenseCents = expenses.reduce((s, e) => s + e.amount_cents, 0);
  const mgmtFeeCents = Math.round((labourCents + expenseCents) * mgmtRate);
  const priorBilledCents = priorInvoices.reduce((s, i) => s + i.amount_cents, 0);

  const lineItems: InvoiceLineItem[] = [];
  if (labourCents > 0) {
    lineItems.push({ description: 'Labour', quantity: 1, unit_price_cents: labourCents, total_cents: labourCents });
  }
  if (expenseCents > 0) {
    lineItems.push({ description: 'Materials & Expenses', quantity: 1, unit_price_cents: expenseCents, total_cents: expenseCents });
  }
  if (mgmtFeeCents > 0) {
    lineItems.push({ description: `Management Fee (${Math.round(mgmtRate * 100)}%)`, quantity: 1, unit_price_cents: mgmtFeeCents, total_cents: mgmtFeeCents });
  }
  if (priorBilledCents > 0) {
    lineItems.push({ description: 'Less: Prior Invoices', quantity: 1, unit_price_cents: -priorBilledCents, total_cents: -priorBilledCents });
  }

  const subtotalCents = lineItems.reduce((s, li) => s + li.total_cents, 0);
  if (subtotalCents <= 0) {
    return { ok: false, error: 'Balance owing is zero or negative — nothing left to invoice.' };
  }
  const taxCents = Math.round(subtotalCents * 0.05);

  const { data, error } = await supabase
    .from('invoices')
    .insert({
      tenant_id: tenant.id,
      project_id: input.projectId,
      customer_id: project.customer_id,
      status: 'draft',
      amount_cents: subtotalCents,
      tax_cents: taxCents,
      line_items: lineItems,
      customer_note: 'Final invoice',
    })
    .select('id')
    .single();

  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create final invoice.' };

  revalidatePath(`/projects/${input.projectId}`);
  revalidatePath('/invoices');
  return { ok: true, id: data.id as string };
}
