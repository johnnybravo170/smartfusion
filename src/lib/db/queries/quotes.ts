/**
 * Quote queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by RLS policies. We never filter on
 * `tenant_id` in application code. Soft-delete: all listers skip
 * rows where `deleted_at IS NOT NULL`.
 */

import { createClient } from '@/lib/supabase/server';
import type { QuoteStatus } from '@/lib/validators/quote';

export type QuoteCustomerSummary = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
};

export type QuoteSurfaceRow = {
  id: string;
  quote_id: string;
  surface_type: string;
  polygon_geojson: unknown;
  sqft: number;
  price_cents: number;
  notes: string | null;
  created_at: string;
};

export type QuoteLineItemRow = {
  id: string;
  quote_id: string;
  label: string;
  qty: number;
  unit: string;
  unit_price_cents: number;
  line_total_cents: number;
  sort_order: number;
  created_at: string;
};

export type QuoteRow = {
  id: string;
  tenant_id: string;
  customer_id: string;
  status: QuoteStatus;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  pdf_url: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type QuoteWithCustomer = QuoteRow & {
  customer: QuoteCustomerSummary | null;
};

export type QuoteWithRelations = QuoteWithCustomer & {
  surfaces: QuoteSurfaceRow[];
  lineItems: QuoteLineItemRow[];
};

export type QuoteListFilters = {
  status?: QuoteStatus;
  customer_id?: string;
  limit?: number;
  offset?: number;
};

export type QuoteStatusCounts = Record<QuoteStatus | 'all', number>;

const QUOTE_COLUMNS =
  'id, tenant_id, customer_id, status, subtotal_cents, tax_cents, total_cents, pdf_url, sent_at, accepted_at, notes, created_at, updated_at, deleted_at';

const QUOTE_WITH_CUSTOMER_SELECT = `${QUOTE_COLUMNS}, customers:customer_id (id, name, email, phone, address_line1, city, province, postal_code)`;

function extractCustomer(raw: unknown): QuoteCustomerSummary | null {
  if (!raw) return null;
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!candidate || typeof candidate !== 'object') return null;
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.id !== 'string' || typeof obj.name !== 'string') return null;
  return {
    id: obj.id,
    name: obj.name,
    email: (obj.email as string) ?? null,
    phone: (obj.phone as string) ?? null,
    address_line1: (obj.address_line1 as string) ?? null,
    city: (obj.city as string) ?? null,
    province: (obj.province as string) ?? null,
    postal_code: (obj.postal_code as string) ?? null,
  };
}

function normalizeQuote(row: Record<string, unknown>): QuoteWithCustomer {
  const { customers: customerRaw, ...rest } = row;
  return {
    ...(rest as QuoteRow),
    customer: extractCustomer(customerRaw),
  };
}

export async function listQuotes(filters: QuoteListFilters = {}): Promise<QuoteWithCustomer[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 200;
  const offset = filters.offset ?? 0;

  let query = supabase.from('quotes').select(QUOTE_WITH_CUSTOMER_SELECT).is('deleted_at', null);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.customer_id) query = query.eq('customer_id', filters.customer_id);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list quotes: ${error.message}`);
  }
  return (data ?? []).map((row) => normalizeQuote(row as Record<string, unknown>));
}

export async function getQuote(id: string): Promise<QuoteWithRelations | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('quotes')
    .select(QUOTE_WITH_CUSTOMER_SELECT)
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load quote: ${error.message}`);
  }
  if (!data) return null;

  const base = normalizeQuote(data as Record<string, unknown>);

  // Fetch surfaces separately (they're in a child table).
  const { data: surfaceData, error: surfErr } = await supabase
    .from('quote_surfaces')
    .select('id, quote_id, surface_type, polygon_geojson, sqft, price_cents, notes, created_at')
    .eq('quote_id', id)
    .order('created_at', { ascending: true });

  if (surfErr) {
    throw new Error(`Failed to load quote surfaces: ${surfErr.message}`);
  }

  const { data: lineItemData, error: liErr } = await supabase
    .from('quote_line_items')
    .select(
      'id, quote_id, label, qty, unit, unit_price_cents, line_total_cents, sort_order, created_at',
    )
    .eq('quote_id', id)
    .order('sort_order', { ascending: true });

  if (liErr) {
    throw new Error(`Failed to load quote line items: ${liErr.message}`);
  }

  return {
    ...base,
    surfaces: (surfaceData ?? []) as QuoteSurfaceRow[],
    lineItems: (lineItemData ?? []) as QuoteLineItemRow[],
  };
}

export async function countQuotesByStatus(): Promise<QuoteStatusCounts> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('quotes').select('status').is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to count quotes: ${error.message}`);
  }

  const counts: QuoteStatusCounts = {
    all: 0,
    draft: 0,
    sent: 0,
    accepted: 0,
    rejected: 0,
    expired: 0,
  };
  for (const row of data ?? []) {
    const s = (row as { status?: string }).status as QuoteStatus;
    if (s in counts) {
      counts[s] += 1;
    }
    counts.all += 1;
  }
  return counts;
}

export type QuoteWorklogEntry = {
  id: string;
  entry_type: 'note' | 'system' | 'milestone';
  title: string | null;
  body: string | null;
  created_at: string;
};

export async function listWorklogForQuote(quoteId: string): Promise<QuoteWorklogEntry[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('worklog_entries')
    .select('id, entry_type, title, body, created_at')
    .eq('related_type', 'quote')
    .eq('related_id', quoteId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to load worklog for quote: ${error.message}`);
  }
  return (data ?? []) as QuoteWorklogEntry[];
}
