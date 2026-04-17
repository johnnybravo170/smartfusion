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
    .select('id, status, amount_cents, tax_cents, job_id, customer_id')
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
  if (!stripeAccountId) {
    return { ok: false, error: 'Connect your Stripe account in Settings before sending invoices.' };
  }

  // Load customer for the checkout line item and email.
  const { data: customer } = await supabase
    .from('customers')
    .select('name, email')
    .eq('id', invoice.customer_id)
    .single();

  const totalCents = invoice.amount_cents + invoice.tax_cents;
  const appFeeCents = Math.round(totalCents * 0.005); // 0.5% platform fee

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  // Create a Stripe Checkout Session on the connected account.
  const session = await getStripe().checkout.sessions.create(
    {
      line_items: [
        {
          price_data: {
            currency: 'cad',
            unit_amount: totalCents,
            product_data: {
              name: `Invoice from ${tenantRow?.name ?? 'your contractor'}`,
              description: customer?.name ? `Service for ${customer.name}` : 'Contractor services',
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

  // Update invoice row.
  // stripe_invoice_id stores checkout session ID; pdf_url stores the payment link.
  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({
      status: 'sent',
      stripe_invoice_id: session.id,
      pdf_url: session.url,
      sent_at: now,
      updated_at: now,
    })
    .eq('id', invoice.id);

  if (updateErr) {
    return {
      ok: false,
      error: `Invoice sent on Stripe but DB update failed: ${updateErr.message}`,
    };
  }

  // Worklog entry.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice sent',
    body: `Invoice #${invoice.id.slice(0, 8)} sent. Payment link created.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  // Email the payment link to the customer.
  const paymentUrl = session.url ?? undefined;
  let warning: string | undefined;

  if (customer?.email && paymentUrl) {
    try {
      const { sendEmail } = await import('@/lib/email/send');
      const { invoiceEmailHtml } = await import('@/lib/email/templates/invoice-email');

      const emailResult = await sendEmail({
        to: customer.email,
        subject: `Invoice from ${tenantRow?.name ?? 'your contractor'} — ${formatCurrency(totalCents)}`,
        html: invoiceEmailHtml({
          customerName: customer.name,
          businessName: tenantRow?.name ?? 'your contractor',
          invoiceNumber: invoice.id.slice(0, 8),
          totalFormatted: formatCurrency(totalCents),
          payUrl: paymentUrl,
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
  } else if (!customer?.email) {
    warning = 'Customer has no email on file. Invoice saved but not emailed.';
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

  const now = new Date().toISOString();
  const { error: updateErr } = await supabase
    .from('invoices')
    .update({ status: 'paid', paid_at: now, updated_at: now })
    .eq('id', invoice.id);

  if (updateErr) {
    return { ok: false, error: `Failed to mark as paid: ${updateErr.message}` };
  }

  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: 'Invoice paid',
    body: `Invoice #${invoice.id.slice(0, 8)} marked as paid manually.`,
    related_type: 'job',
    related_id: invoice.job_id,
  });

  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath(`/jobs/${invoice.job_id}`);
  return { ok: true, id: invoice.id };
}
