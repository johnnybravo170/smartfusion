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
  /** New kind column (Slice A). Present on every row. */
  kind: 'lead' | 'customer' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  /**
   * Legacy subtype field. For backwards-compat the query layer synthesizes
   * 'agent' here when `kind='agent'`, and for other non-customer kinds
   * falls back to 'residential'. Callers that care about the real model
   * should branch on `kind` first.
   */
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
  /**
   * Legacy subtype filter (residential/commercial/agent). Treated as a kind
   * filter when set to 'agent'; otherwise as a customer-subtype filter.
   */
  type?: 'residential' | 'commercial' | 'agent';
  /** New kind-first filter. Takes precedence over `type` when both are set. */
  kind?: 'lead' | 'customer' | 'vendor' | 'sub' | 'agent' | 'inspector' | 'referral' | 'other';
  limit?: number;
  offset?: number;
};

const CUSTOMER_COLUMNS =
  'id, tenant_id, kind, type, name, email, phone, address_line1, city, province, postal_code, notes, created_at, updated_at, deleted_at';

/**
 * For the duration of the contacts-unification rollout (Slice A), readers
 * still expect a flat `type` field with legacy values (residential |
 * commercial | agent). Map the persisted `kind` + `type` pair onto that
 * surface: agent rows now carry `kind='agent', type=NULL` in the DB, so we
 * synthesize 'agent' here. Non-customer/agent kinds (vendor, sub, etc.)
 * are not produced by the existing UI yet, but we return their `kind`
 * string so nothing dies if one shows up.
 */
function synthesizeLegacyType(row: {
  kind?: string | null;
  type?: string | null;
}): 'residential' | 'commercial' | 'agent' {
  if (row.kind === 'agent') return 'agent';
  if (row.type === 'residential' || row.type === 'commercial') return row.type;
  // Fallback — callers treat it as a customer subtype. Safe default for rollout.
  return 'residential';
}

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
  if (filters.kind) {
    // Kind-first filter (Slice C). May be combined with a customer subtype
    // via `type` when `kind === 'customer'`.
    q = q.eq('kind', filters.kind);
    if (
      filters.kind === 'customer' &&
      (filters.type === 'residential' || filters.type === 'commercial')
    ) {
      q = q.eq('type', filters.type);
    }
  } else if (filters.type === 'agent') {
    // Legacy filter: agent rows now live under `kind='agent'` (type is NULL).
    q = q.eq('kind', 'agent');
  } else if (filters.type) {
    // Legacy residential / commercial filter — constrain to kind='customer'
    // so vendor/sub/etc. don't leak in.
    q = q.eq('kind', 'customer').eq('type', filters.type);
  }

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
  return (data ?? []).map((row) => ({
    ...(row as unknown as CustomerRow),
    type: synthesizeLegacyType(row as { kind?: string | null; type?: string | null }),
  })) as CustomerRow[];
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
  if (!data) return null;
  return {
    ...(data as unknown as CustomerRow),
    type: synthesizeLegacyType(data as { kind?: string | null; type?: string | null }),
  } as CustomerRow;
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
