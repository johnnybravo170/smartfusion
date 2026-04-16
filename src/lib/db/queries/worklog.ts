/**
 * Work log queries that run through the RLS-aware Supabase server client.
 *
 * Tenant isolation is enforced by `current_tenant_id()` in the
 * `worklog_entries` RLS policies (migration 0016). `search_vector` is a
 * generated tsvector column (migration 0019); `searchWorklog()` uses
 * Supabase `textSearch()` with the `websearch` type for a Google-like
 * query grammar (quoted phrases, `-excluded`, `OR`).
 *
 * Entries can reference a customer or job. We hydrate the related name via
 * two batched lookups after the main query so the UI can render a badge
 * without a per-row round-trip.
 *
 * See PHASE_1_PLAN.md §8 Track E.
 */

import { createClient } from '@/lib/supabase/server';
import type { WorklogEntryType, WorklogRelatedType } from '@/lib/validators/worklog';

export type WorklogRow = {
  id: string;
  tenant_id: string;
  user_id: string | null;
  entry_type: WorklogEntryType;
  title: string | null;
  body: string | null;
  related_type: WorklogRelatedType | null;
  related_id: string | null;
  created_at: string;
  updated_at: string;
};

export type WorklogRowWithRelated = WorklogRow & {
  related_name: string | null;
};

export type WorklogListFilters = {
  entry_type?: WorklogEntryType;
  related_type?: WorklogRelatedType;
  related_id?: string;
  limit?: number;
  offset?: number;
};

const WORKLOG_COLUMNS =
  'id, tenant_id, user_id, entry_type, title, body, related_type, related_id, created_at, updated_at';

/**
 * Resolve display names for (customer|job) related entries in a single
 * round-trip per type. Keeps the related badge free regardless of list size.
 */
async function hydrateRelatedNames(rows: WorklogRow[]): Promise<WorklogRowWithRelated[]> {
  const customerIds = new Set<string>();
  const jobIds = new Set<string>();
  for (const r of rows) {
    if (!r.related_id) continue;
    if (r.related_type === 'customer') customerIds.add(r.related_id);
    if (r.related_type === 'job') jobIds.add(r.related_id);
  }

  if (customerIds.size === 0 && jobIds.size === 0) {
    return rows.map((r) => ({ ...r, related_name: null }));
  }

  const supabase = await createClient();
  const nameById = new Map<string, string>();

  if (customerIds.size > 0) {
    const { data } = await supabase
      .from('customers')
      .select('id, name')
      .in('id', Array.from(customerIds));
    for (const row of data ?? []) {
      nameById.set(row.id as string, (row as { name: string }).name);
    }
  }

  if (jobIds.size > 0) {
    // Jobs don't have their own name — surface the linked customer name.
    const { data } = await supabase
      .from('jobs')
      .select('id, customers:customer_id (name)')
      .in('id', Array.from(jobIds));
    for (const row of data ?? []) {
      const customerRaw = (row as { customers?: unknown }).customers;
      const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
      const name =
        customer && typeof customer === 'object' && 'name' in customer
          ? (customer as { name: string }).name
          : 'Job';
      nameById.set((row as { id: string }).id, name);
    }
  }

  return rows.map((r) => ({
    ...r,
    related_name: r.related_id ? (nameById.get(r.related_id) ?? null) : null,
  }));
}

export async function listWorklog(
  filters: WorklogListFilters = {},
): Promise<WorklogRowWithRelated[]> {
  const supabase = await createClient();
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;

  let query = supabase.from('worklog_entries').select(WORKLOG_COLUMNS);
  if (filters.entry_type) query = query.eq('entry_type', filters.entry_type);
  if (filters.related_type) query = query.eq('related_type', filters.related_type);
  if (filters.related_id) query = query.eq('related_id', filters.related_id);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    throw new Error(`Failed to list worklog: ${error.message}`);
  }

  return hydrateRelatedNames((data ?? []) as WorklogRow[]);
}

/**
 * Websearch-style full-text search over title + body, ranked by tsvector
 * weighting (title = A, body = B — see migration 0019). Supabase escapes the
 * query for us when `type: 'websearch'` is set.
 */
export async function searchWorklog(query: string, limit = 50): Promise<WorklogRowWithRelated[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('worklog_entries')
    .select(WORKLOG_COLUMNS)
    .textSearch('search_vector', trimmed, { type: 'websearch' })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed to search worklog: ${error.message}`);
  }

  return hydrateRelatedNames((data ?? []) as WorklogRow[]);
}

export async function countWorklog(
  filters: Pick<WorklogListFilters, 'entry_type' | 'related_type'> = {},
): Promise<number> {
  const supabase = await createClient();
  let query = supabase.from('worklog_entries').select('id', { count: 'exact', head: true });

  if (filters.entry_type) query = query.eq('entry_type', filters.entry_type);
  if (filters.related_type) query = query.eq('related_type', filters.related_type);

  const { count, error } = await query;
  if (error) {
    throw new Error(`Failed to count worklog: ${error.message}`);
  }
  return count ?? 0;
}
