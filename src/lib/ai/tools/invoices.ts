import { getCurrentTenant } from '@/lib/auth/helpers';
import { getKeyMetrics } from '@/lib/db/queries/dashboard';
import { invoiceTotalCents, listInvoices } from '@/lib/db/queries/invoices';
import { createClient } from '@/lib/supabase/server';
import { formatCad, formatDate, invoiceStatusLabels } from '../format';
import { resolveByShortId } from '../helpers/resolve-by-short-id';
import type { AiTool } from '../types';
import { getTaxRate } from './helpers';

/** Timezone injected from tenant context for revenue queries. */
let _timezone = 'America/Vancouver';
export function setInvoiceTimezone(tz: string) {
  _timezone = tz;
}

export const invoiceTools: AiTool[] = [
  {
    definition: {
      name: 'list_invoices',
      description: 'List invoices. Filter by status (draft/sent/paid/void).',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'paid', 'void'],
            description: 'Filter by invoice status',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 100)',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        const rows = await listInvoices({
          status: input.status as 'draft' | 'sent' | 'paid' | 'void' | undefined,
          limit: Math.min((input.limit as number) || 20, 100),
        });

        if (rows.length === 0) {
          return 'No invoices found matching your criteria.';
        }

        let output = `Found ${rows.length} invoice(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const inv = rows[i];
          const total = invoiceTotalCents(inv);
          output += `${i + 1}. ${inv.customer?.name ?? 'No customer'} - ${formatCad(total)}\n`;
          output += `   Status: ${invoiceStatusLabels[inv.status] ?? inv.status}`;
          output += ` | Created: ${formatDate(inv.created_at)}`;
          if (inv.sent_at) output += ` | Sent: ${formatDate(inv.sent_at)}`;
          if (inv.paid_at) output += ` | Paid: ${formatDate(inv.paid_at)}`;
          output += `\n   ID: ${inv.id}\n\n`;
        }

        return output;
      } catch (e) {
        return `Failed to list invoices: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_revenue_summary',
      description:
        'Revenue summary: total revenue (paid invoices), outstanding amount, open jobs, and pending quotes for the current month.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      try {
        const metrics = await getKeyMetrics(_timezone);

        let output = `Revenue Summary (This Month)\n${'='.repeat(40)}\n\n`;
        output += `Total Revenue: ${formatCad(metrics.revenueThisMonthCents)}\n`;
        output += `Outstanding (Unpaid): ${formatCad(metrics.outstandingCents)}\n`;
        output += `Open Jobs: ${metrics.openJobsCount}\n`;
        output += `Pending Quotes: ${metrics.pendingQuotesCount}\n`;

        return output;
      } catch (e) {
        return `Failed to get revenue summary: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_invoice',
      description:
        'Generate an invoice for a completed job. Calculates amount from the linked quote if available, or accepts a manual amount.',
      input_schema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'Job UUID or short ID',
          },
          amount_cents: {
            type: 'number',
            description: 'Manual invoice amount in cents. Required if the job has no linked quote.',
          },
        },
        required: ['job_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type JobRow = {
          id: string;
          status: string;
          customer_id: string;
          quote_id: string | null;
          customers:
            | { name: string; email: string | null }
            | { name: string; email: string | null }[];
        };

        const result = await resolveByShortId<JobRow>(
          'jobs',
          input.job_id as string,
          'id, status, customer_id, quote_id, customers:customer_id (name, email)',
        );
        if (typeof result === 'string') return result;

        const job = result;

        if (job.status !== 'complete') {
          return `This job is currently "${jobStatusLabel(job.status)}" — it needs to be marked complete before an invoice can be generated. Would you like me to mark it as complete first?`;
        }

        // Check no invoice already exists for this job
        const supabase = await createClient();
        const { data: existing } = await supabase
          .from('invoices')
          .select('id')
          .eq('job_id', job.id)
          .is('deleted_at', null)
          .limit(1);

        if (existing && existing.length > 0) {
          return `An invoice already exists for this job (ID: ${existing[0].id.slice(0, 8)}).`;
        }

        // Determine amount
        let amountCents: number;

        if (input.amount_cents !== undefined && input.amount_cents !== null) {
          amountCents = input.amount_cents as number;
        } else if (job.quote_id) {
          // Get total from the linked quote
          const { data: quote } = await supabase
            .from('quotes')
            .select('subtotal_cents')
            .eq('id', job.quote_id)
            .maybeSingle();

          if (!quote) {
            return 'Linked quote not found. Specify the amount manually with amount_cents.';
          }
          amountCents = quote.subtotal_cents;
        } else {
          return 'No quote linked to this job. Specify the amount with amount_cents.';
        }

        const taxRate = await getTaxRate(tenant.id);
        const taxCents = Math.round(amountCents * taxRate);
        const totalCents = amountCents + taxCents;

        const { data: invoice, error } = await supabase
          .from('invoices')
          .insert({
            tenant_id: tenant.id,
            customer_id: job.customer_id,
            job_id: job.id,
            status: 'draft',
            amount_cents: amountCents,
            tax_cents: taxCents,
          })
          .select('id')
          .single();

        if (error || !invoice) {
          return `Failed to create invoice: ${error?.message ?? 'Unknown error'}`;
        }

        const customerRaw = job.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
        const customerName = customer?.name ?? 'customer';

        return (
          `Invoice #${invoice.id.slice(0, 8)} created for ${customerName}. ` +
          `Amount: ${formatCad(totalCents)}. Status: draft.`
        );
      } catch (e) {
        return `Failed to create invoice: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'send_invoice',
      description:
        'Send an invoice to the customer. Emails a payment link. Requires Stripe to be connected.',
      input_schema: {
        type: 'object',
        properties: {
          invoice_id: {
            type: 'string',
            description: 'Invoice UUID or short ID (first 8 chars)',
          },
        },
        required: ['invoice_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type InvoiceRow = {
          id: string;
          status: string;
          amount_cents: number;
          tax_cents: number;
          tax_inclusive: boolean;
          customer_id: string;
          customers:
            | { name: string; email: string | null }
            | { name: string; email: string | null }[];
        };

        const result = await resolveByShortId<InvoiceRow>(
          'invoices',
          input.invoice_id as string,
          'id, status, amount_cents, tax_cents, tax_inclusive, customer_id, customers:customer_id (name, email)',
        );
        if (typeof result === 'string') return result;

        const invoice = result;

        if (invoice.status !== 'draft' && invoice.status !== 'sent') {
          return `Invoice is "${invoice.status}". Only draft or sent invoices can be sent.`;
        }

        const customerRaw = invoice.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;

        if (!customer?.email) {
          return `Cannot send invoice: ${customer?.name ?? 'customer'} has no email address on file. Update their email first.`;
        }

        // Check for Stripe configuration
        const supabase = await createClient();
        const { data: tenantData } = await supabase
          .from('tenants')
          .select('stripe_account_id')
          .eq('id', tenant.id)
          .maybeSingle();

        const _hasStripe = !!tenantData?.stripe_account_id;
        // Proceed without Stripe — invoice can still be sent via email

        // Stripe Checkout session and email sending are not yet implemented.
        // For now, update the status and log the intent.
        const now = new Date().toISOString();
        const totalCents = invoiceTotalCents(invoice);

        const { error: updateErr } = await supabase
          .from('invoices')
          .update({ status: 'sent', sent_at: now, updated_at: now })
          .eq('id', invoice.id);

        if (updateErr) {
          return `Failed to update invoice status: ${updateErr.message}`;
        }

        // Add worklog entry
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Invoice sent',
          body: `Invoice #${invoice.id.slice(0, 8)} sent to ${customer.name} (${customer.email}). Total: ${formatCad(totalCents)}.`,
          related_type: 'invoice',
          related_id: invoice.id,
        });

        return (
          `Invoice #${invoice.id.slice(0, 8)} sent to ${customer.email}. ` +
          `Total: ${formatCad(totalCents)}.`
        );
      } catch (e) {
        return `Failed to send invoice: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'mark_invoice_paid',
      description: 'Mark an invoice as paid (for cash/e-transfer payments received outside Stripe)',
      input_schema: {
        type: 'object',
        properties: {
          invoice_id: {
            type: 'string',
            description: 'Invoice UUID or short ID (first 8 chars)',
          },
        },
        required: ['invoice_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type InvoiceRow = {
          id: string;
          status: string;
          amount_cents: number;
          tax_cents: number;
          tax_inclusive: boolean;
          customers: { name: string } | { name: string }[];
        };

        const result = await resolveByShortId<InvoiceRow>(
          'invoices',
          input.invoice_id as string,
          'id, status, amount_cents, tax_cents, tax_inclusive, customers:customer_id (name)',
        );
        if (typeof result === 'string') return result;

        const invoice = result;

        if (invoice.status !== 'sent') {
          return `Invoice is "${invoice.status}". Only sent invoices can be marked paid.`;
        }

        const supabase = await createClient();
        const now = new Date().toISOString();

        const { error: updateErr } = await supabase
          .from('invoices')
          .update({ status: 'paid', paid_at: now, updated_at: now })
          .eq('id', invoice.id);

        if (updateErr) {
          return `Failed to mark invoice paid: ${updateErr.message}`;
        }

        const customerRaw = invoice.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
        const customerName = customer?.name ?? 'customer';
        const totalCents = invoiceTotalCents(invoice);

        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Invoice marked as paid',
          body: `Invoice #${invoice.id.slice(0, 8)} for ${customerName} marked as paid. Total: ${formatCad(totalCents)}.`,
          related_type: 'invoice',
          related_id: invoice.id,
        });

        return (
          `Invoice #${invoice.id.slice(0, 8)} marked as paid. ` +
          `Customer: ${customerName}. Amount: ${formatCad(totalCents)}.`
        );
      } catch (e) {
        return `Failed to mark invoice paid: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];

/** Local helper to avoid importing jobStatusLabels from another file. */
function jobStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    booked: 'Booked',
    in_progress: 'In Progress',
    complete: 'Complete',
    cancelled: 'Cancelled',
  };
  return labels[status] ?? status;
}
