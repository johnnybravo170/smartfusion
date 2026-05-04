/**
 * Read query for the BR-7 review queue. Returns suggested bank
 * transactions ordered by best match first.
 *
 * Strategic line: we don't surface `unmatched` rows by default — those
 * are QBO's problem (transfers, fees, interest, etc). The caller can
 * pass `include_unmatched: true` if they want to see them anyway.
 */

import type { MatchCandidate } from '@/lib/bank-recon/matcher';
import { createClient } from '@/lib/supabase/server';

export type BankReviewRow = {
  id: string;
  statement_id: string;
  statement_label: string;
  posted_at: string;
  amount_cents: number;
  description: string;
  match_status: 'unmatched' | 'suggested' | 'confirmed' | 'rejected' | 'manual';
  match_score: number | null;
  match_confidence: 'high' | 'medium' | 'low' | null;
  match_candidates: MatchCandidate[];
};

export type ReviewQueueFilters = {
  statement_id?: string;
  include_unmatched?: boolean;
};

const PAGE_SIZE = 200;

export async function listBankReviewQueue(filters: ReviewQueueFilters = {}): Promise<{
  rows: BankReviewRow[];
  counts: {
    suggested_high: number;
    suggested_medium: number;
    suggested_low: number;
    unmatched: number;
    confirmed: number;
    rejected: number;
  };
}> {
  const supabase = await createClient();

  // Counts roll-up across the entire (filtered) statement, not just the page.
  // Lightweight aggregate query — one row per status × confidence bucket.
  let countQuery = supabase
    .from('bank_transactions')
    .select('match_status, match_confidence', { count: 'exact', head: false });
  if (filters.statement_id) countQuery = countQuery.eq('statement_id', filters.statement_id);
  const countRes = await countQuery;
  if (countRes.error) throw new Error(countRes.error.message);

  const counts = {
    suggested_high: 0,
    suggested_medium: 0,
    suggested_low: 0,
    unmatched: 0,
    confirmed: 0,
    rejected: 0,
  };
  for (const r of countRes.data ?? []) {
    const status = r.match_status as string;
    const conf = r.match_confidence as 'high' | 'medium' | 'low' | null;
    if (status === 'suggested') {
      if (conf === 'high') counts.suggested_high++;
      else if (conf === 'medium') counts.suggested_medium++;
      else counts.suggested_low++;
    } else if (status === 'unmatched') counts.unmatched++;
    else if (status === 'confirmed') counts.confirmed++;
    else if (status === 'rejected') counts.rejected++;
  }

  // Page query — suggested first, then unmatched if asked, ordered by score.
  const statuses = filters.include_unmatched ? ['suggested', 'unmatched'] : ['suggested'];

  let rowQuery = supabase
    .from('bank_transactions')
    .select(
      `id, statement_id, posted_at, amount_cents, description, match_status,
       match_score, match_confidence, match_candidates,
       statement:bank_statements!inner(source_label)`,
    )
    .in('match_status', statuses)
    .order('match_score', { ascending: false, nullsFirst: false })
    .order('posted_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (filters.statement_id) rowQuery = rowQuery.eq('statement_id', filters.statement_id);
  const { data, error } = await rowQuery;
  if (error) throw new Error(error.message);

  const rows: BankReviewRow[] = (data ?? []).map((r) => ({
    id: r.id as string,
    statement_id: r.statement_id as string,
    statement_label: statementLabel(r.statement),
    posted_at: r.posted_at as string,
    amount_cents: r.amount_cents as number,
    description: r.description as string,
    match_status: r.match_status as BankReviewRow['match_status'],
    match_score: (r.match_score as number | null) ?? null,
    match_confidence: (r.match_confidence as 'high' | 'medium' | 'low' | null) ?? null,
    match_candidates: ((r.match_candidates as MatchCandidate[] | null) ?? []) as MatchCandidate[],
  }));

  return { rows, counts };
}

function statementLabel(rel: unknown): string {
  if (!rel) return '';
  if (Array.isArray(rel))
    return (rel[0] as { source_label?: string } | undefined)?.source_label ?? '';
  return (rel as { source_label?: string }).source_label ?? '';
}

export async function listImportedStatements(): Promise<
  Array<{
    id: string;
    source_label: string;
    uploaded_at: string;
    row_count: number;
    matched_count: number;
  }>
> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('bank_statements')
    .select('id, source_label, uploaded_at, row_count, matched_count')
    .order('uploaded_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    source_label: r.source_label as string,
    uploaded_at: r.uploaded_at as string,
    row_count: (r.row_count as number) ?? 0,
    matched_count: (r.matched_count as number) ?? 0,
  }));
}
