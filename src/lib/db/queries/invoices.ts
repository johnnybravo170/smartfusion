/**
 * Invoice queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by RLS policies on the `invoices` table.
 * Soft-delete: all listers skip rows where `deleted_at` is not null.
 *
 * DB columns mapping (see 0011_invoices.sql):
 *   stripe_invoice_id   -> stores the Stripe Checkout Session ID
 *   pdf_url             -> stores the Stripe Checkout payment URL
 */

import { createClient } from '@/lib/supabase/server';
import type { InvoiceStatus } from '@/lib/validators/invoice';

export type InvoiceCustomerSummary = {
  id: string;
  name: string;
  email: string | null;
};

export type InvoiceRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  customer_id: string;
  status: InvoiceStatus;
  amount_cents: number;
  tax_cents: number;
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  pdf_url: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type InvoiceWithCustomer = InvoiceRow & {
  customer: InvoiceCustomerSummary | null;
};

export type InvoiceWithRelations = InvoiceWithCustomer & {
  job: { id: string; status: string; scheduled_at: string | null } | null;
};

export type InvoiceListFilters = {
  status?: InvoiceStatus;
  customer_id?: string;
  limit?: number;
  offset?: number;
};

const INVOICE_COLUMNS =
  'id, tenant_id, job_id, customer_id, status, amount_cents, tax_cents, stripe_invoice_id, stripe_payment_intent_id, pdf_url, sent_at, paid_at, created_at, updated_at, deleted_at';

function extractRelation<T>(raw: unknown): T | null {
  if (!raw) return null;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  return candidate as T;
}

export async function listInvoices(
  filters: InvoiceListFilters = {},
): Promise<InvoiceWithCustomer[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  let query = supabase
    .from('invoices')
    .select(`${INVOICE_COLUMNS}, customers:customer_id (id, name, email)`)
    .is('deleted_at', null);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list invoices: ${error.message}`);
  }

  return (data ?? []).map((row) => {
    const { customers: customerRaw, ...rest } = row as Record<string, unknown>;
    return {
      ...(rest as InvoiceRow),
      customer: extractRelation<InvoiceCustomerSummary>(customerRaw),
    };
  });
}

export async function getInvoice(id: string): Promise<InvoiceWithRelations | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('invoices')
    .select(
      `${INVOICE_COLUMNS},
       customers:customer_id (id, name, email),
       jobs:job_id (id, status, scheduled_at)`,
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load invoice: ${error.message}`);
  }
  if (!data) return null;

  const { customers: customerRaw, jobs: jobRaw, ...rest } = data as Record<string, unknown>;

  return {
    ...(rest as InvoiceRow),
    customer: extractRelation<InvoiceCustomerSummary>(customerRaw),
    job: extractRelation<{ id: string; status: string; scheduled_at: string | null }>(jobRaw),
  };
}

export async function getInvoiceByJob(jobId: string): Promise<InvoiceRow | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('invoices')
    .select(INVOICE_COLUMNS)
    .eq('job_id', jobId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load invoice for job: ${error.message}`);
  }

  return (data as InvoiceRow) ?? null;
}
