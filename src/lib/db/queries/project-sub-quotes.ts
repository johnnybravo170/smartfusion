/**
 * Sub quote queries — listings + committed totals by bucket.
 *
 * `committed` = sum of allocations across all `accepted` sub quotes on a
 * project, grouped by bucket. Feeds the Costs tab's "Sub quotes" section
 * and (later) the Job Cost Control V1 variance view.
 */

import { createClient } from '@/lib/supabase/server';

export type SubQuoteAllocationRow = {
  id: string;
  budget_category_id: string;
  budget_category_name: string | null;
  allocated_cents: number;
  notes: string | null;
};

export type SubQuoteRow = {
  id: string;
  vendor_name: string;
  vendor_email: string | null;
  vendor_phone: string | null;
  total_cents: number;
  scope_description: string | null;
  notes: string | null;
  status: 'pending_review' | 'accepted' | 'rejected' | 'expired' | 'superseded';
  superseded_by_id: string | null;
  quote_date: string | null;
  valid_until: string | null;
  received_at: string;
  source: 'manual' | 'upload' | 'email';
  attachment_storage_path: string | null;
  created_at: string;
  allocations: SubQuoteAllocationRow[];
};

export async function listProjectSubQuotes(projectId: string): Promise<SubQuoteRow[]> {
  const supabase = await createClient();

  const { data: quotes, error } = await supabase
    .from('project_sub_quotes')
    .select(
      'id, vendor_name, vendor_email, vendor_phone, total_cents, scope_description, notes, status, superseded_by_id, quote_date, valid_until, received_at, source, attachment_storage_path, created_at',
    )
    .eq('project_id', projectId)
    .order('received_at', { ascending: false });
  if (error) throw new Error(`listProjectSubQuotes: ${error.message}`);
  if (!quotes?.length) return [];

  const ids = quotes.map((q) => q.id as string);

  const { data: allocations } = await supabase
    .from('project_sub_quote_allocations')
    .select(
      'id, sub_quote_id, budget_category_id, allocated_cents, notes, project_budget_categories:budget_category_id(name)',
    )
    .in('sub_quote_id', ids);

  const allocsByQuote = new Map<string, SubQuoteAllocationRow[]>();
  for (const a of allocations ?? []) {
    const bucket = a.project_budget_categories as { name?: string } | { name?: string }[] | null;
    const bucketName = Array.isArray(bucket) ? (bucket[0]?.name ?? null) : (bucket?.name ?? null);
    const row: SubQuoteAllocationRow = {
      id: a.id as string,
      budget_category_id: a.budget_category_id as string,
      budget_category_name: bucketName,
      allocated_cents: a.allocated_cents as number,
      notes: (a.notes as string | null) ?? null,
    };
    const key = a.sub_quote_id as string;
    const list = allocsByQuote.get(key) ?? [];
    list.push(row);
    allocsByQuote.set(key, list);
  }

  return quotes.map((q) => ({
    id: q.id as string,
    vendor_name: q.vendor_name as string,
    vendor_email: (q.vendor_email as string | null) ?? null,
    vendor_phone: (q.vendor_phone as string | null) ?? null,
    total_cents: q.total_cents as number,
    scope_description: (q.scope_description as string | null) ?? null,
    notes: (q.notes as string | null) ?? null,
    status: q.status as SubQuoteRow['status'],
    superseded_by_id: (q.superseded_by_id as string | null) ?? null,
    quote_date: (q.quote_date as string | null) ?? null,
    valid_until: (q.valid_until as string | null) ?? null,
    received_at: q.received_at as string,
    source: q.source as SubQuoteRow['source'],
    attachment_storage_path: (q.attachment_storage_path as string | null) ?? null,
    created_at: q.created_at as string,
    allocations: allocsByQuote.get(q.id as string) ?? [],
  }));
}
