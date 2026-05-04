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

export type InvoiceLineItem = {
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
};

export type InvoiceRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  customer_id: string;
  status: InvoiceStatus;
  amount_cents: number;
  tax_cents: number;
  tax_inclusive: boolean;
  doc_type: 'invoice' | 'draw';
  stripe_invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  pdf_url: string | null;
  sent_at: string | null;
  paid_at: string | null;
  payment_method: string | null;
  payment_reference: string | null;
  payment_notes: string | null;
  payment_receipt_paths: string[] | null;
  customer_note: string | null;
  line_items: InvoiceLineItem[];
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
  'id, tenant_id, job_id, customer_id, status, amount_cents, tax_cents, tax_inclusive, doc_type, stripe_invoice_id, stripe_payment_intent_id, pdf_url, sent_at, paid_at, payment_method, payment_reference, payment_notes, payment_receipt_paths, customer_note, line_items, created_at, updated_at, deleted_at';

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

/**
 * Sum of draws ($X sent · $Y paid · $Z outstanding) for the project header.
 * Includes only invoices with doc_type='draw'. Outstanding = sent (not paid)
 * + paid... wait — outstanding = sent_total − paid_total, where sent_total
 * is everything that has gone out (status in 'sent' or 'paid'), and
 * paid_total is just status='paid'. Drafts and voids excluded.
 */
export type ProjectDrawSummary = {
  sent_cents: number;
  paid_cents: number;
  outstanding_cents: number;
  has_any: boolean;
};

export async function getProjectDrawSummary(projectId: string): Promise<ProjectDrawSummary> {
  const supabase = await createClient();
  // Draws are tied to jobs (via job_id) and jobs to projects. Pull all
  // draws under any job linked to this project.
  const { data: jobs } = await supabase.from('jobs').select('id').eq('project_id', projectId);
  const jobIds = (jobs ?? []).map((j) => j.id as string);
  if (jobIds.length === 0) {
    return { sent_cents: 0, paid_cents: 0, outstanding_cents: 0, has_any: false };
  }
  const { data: rows } = await supabase
    .from('invoices')
    .select('amount_cents, tax_cents, tax_inclusive, status, doc_type')
    .in('job_id', jobIds)
    .eq('doc_type', 'draw')
    .is('deleted_at', null)
    .in('status', ['sent', 'paid']);

  let sent = 0;
  let paid = 0;
  for (const r of rows ?? []) {
    const row = r as {
      amount_cents: number;
      tax_cents: number;
      tax_inclusive: boolean;
      status: string;
    };
    // tax_inclusive: amount_cents IS the total. Otherwise add tax on top.
    const total = row.tax_inclusive
      ? (row.amount_cents ?? 0)
      : (row.amount_cents ?? 0) + (row.tax_cents ?? 0);
    sent += total;
    if (row.status === 'paid') paid += total;
  }
  return {
    sent_cents: sent,
    paid_cents: paid,
    outstanding_cents: sent - paid,
    has_any: (rows ?? []).length > 0,
  };
}
