/**
 * Customer queries that run through the RLS-aware Supabase server client.
 *
 * These helpers never pass the admin/service-role client — tenant isolation
 * is enforced by `current_tenant_id()` on every `customers` policy (see
 * migrations 0016_all_rls_policies.sql). That means we don't filter on
 * `tenant_id` in application code either; doing so would be redundant and
 * hide RLS failures.
 *
 * Soft-delete: `customers.deleted_at` is added in 0018. All listers skip
 * soft-deleted rows. `getCustomer` optionally includes them for admin UX.
 */

import { createClient } from '@/lib/supabase/server';

export type CustomerRow = {
  id: string;
  tenant_id: string;
  type: 'residential' | 'commercial' | 'agent';
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type RelatedQuote = {
  id: string;
  status: string;
  total_cents: number;
  created_at: string;
};

export type RelatedJob = {
  id: string;
  status: string;
  scheduled_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export type RelatedInvoice = {
  id: string;
  status: string;
  amount_cents: number;
  tax_cents: number;
  created_at: string;
};

export type CustomerListFilters = {
  search?: string;
  type?: 'residential' | 'commercial' | 'agent';
  limit?: number;
  offset?: number;
};

const CUSTOMER_COLUMNS =
  'id, tenant_id, type, name, email, phone, address_line1, city, province, postal_code, notes, created_at, updated_at, deleted_at';

/**
 * Escape a search term for use in `ilike` / `or` filters. Supabase expects
 * commas to be escaped inside `or(...)` and percent/underscore are `LIKE`
 * wildcards we want to take literally.
 */
function escapeForOr(term: string) {
  return term.replace(/[\\%,()]/g, '\\$&');
}

/**
 * Build the base SELECT query with soft-delete and optional search/type
 * filters applied. The RLS policy handles tenant scoping — do not add a
 * `.eq('tenant_id', …)` here.
 */
function applyListFilters<
  T extends {
    is: (col: string, value: null) => T;
    eq: (col: string, value: string) => T;
    or: (expr: string) => T;
  },
>(query: T, filters: CustomerListFilters): T {
  let q = query.is('deleted_at', null);
  if (filters.type) q = q.eq('type', filters.type);

  const search = filters.search?.trim();
  if (search) {
    const needle = `%${escapeForOr(search)}%`;
    q = q.or(
      `name.ilike.${needle},email.ilike.${needle},phone.ilike.${needle},city.ilike.${needle}`,
    );
  }
  return q;
}

export async function listCustomers(filters: CustomerListFilters = {}): Promise<CustomerRow[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  let query = supabase.from('customers').select(CUSTOMER_COLUMNS);
  query = applyListFilters(query, filters) as typeof query;

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list customers: ${error.message}`);
  }
  return (data ?? []) as CustomerRow[];
}

export async function countCustomers(filters: CustomerListFilters = {}): Promise<number> {
  const supabase = await createClient();
  let query = supabase.from('customers').select('id', { count: 'exact', head: true });
  query = applyListFilters(query, filters) as typeof query;

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count customers: ${error.message}`);
  }
  return count ?? 0;
}

export async function getCustomer(id: string): Promise<CustomerRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('customers')
    .select(CUSTOMER_COLUMNS)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    // `maybeSingle` returns an error when the row is missing on some
    // client versions; treat PGRST116 as "not found".
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load customer: ${error.message}`);
  }
  return (data as CustomerRow | null) ?? null;
}

export type CustomerRelated = {
  quotes: RelatedQuote[];
  jobs: RelatedJob[];
  invoices: RelatedInvoice[];
};

export async function getCustomerRelated(id: string): Promise<CustomerRelated> {
  const supabase = await createClient();

  const [quotesRes, jobsRes, invoicesRes] = await Promise.all([
    supabase
      .from('quotes')
      .select('id, status, total_cents, created_at')
      .eq('customer_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('jobs')
      .select('id, status, scheduled_at, completed_at, created_at')
      .eq('customer_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20),
    supabase
      .from('invoices')
      .select('id, status, amount_cents, tax_cents, created_at')
      .eq('customer_id', id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (quotesRes.error) {
    throw new Error(`Failed to load related quotes: ${quotesRes.error.message}`);
  }
  if (jobsRes.error) {
    throw new Error(`Failed to load related jobs: ${jobsRes.error.message}`);
  }
  if (invoicesRes.error) {
    throw new Error(`Failed to load related invoices: ${invoicesRes.error.message}`);
  }

  return {
    quotes: (quotesRes.data ?? []) as RelatedQuote[],
    jobs: (jobsRes.data ?? []) as RelatedJob[],
    invoices: (invoicesRes.data ?? []) as RelatedInvoice[],
  };
}
