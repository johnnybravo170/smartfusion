'use server';

/**
 * BR-5 server action — runs the auto-match engine against a statement's
 * unmatched transactions and writes the results.
 *
 * Two callers:
 *   1. importBankStatementAction (BR-4) — fires immediately after writing
 *      transactions, so the user lands in the review queue with matches
 *      already populated.
 *   2. A future "Re-run matching" button (post BR-7) — re-runs the matcher
 *      after the GC manually adds an invoice or expense the matcher missed
 *      the first time.
 *
 * Idempotent: only touches transactions still in `match_status='unmatched'`.
 * Confirmed/rejected/manual rows are left alone — operator decisions win.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { findMatchCandidates } from '@/lib/bank-recon/matcher';
import { getMatchPool } from '@/lib/db/queries/bank-match-candidates';
import { createClient } from '@/lib/supabase/server';

export type AutoMatchResult =
  | {
      ok: true;
      scanned: number;
      matched: number;
      high_confidence: number;
      medium_confidence: number;
      low_confidence: number;
    }
  | { ok: false; error: string };

const BATCH_LIMIT = 5000;

export async function runAutoMatchAction(input: {
  statement_id?: string;
}): Promise<AutoMatchResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // 1. Fetch unmatched transactions (optionally scoped to a single statement).
  let txQuery = supabase
    .from('bank_transactions')
    .select('id, posted_at, amount_cents, description')
    .eq('match_status', 'unmatched')
    .limit(BATCH_LIMIT);
  if (input.statement_id) {
    txQuery = txQuery.eq('statement_id', input.statement_id);
  }
  const { data: txs, error: txErr } = await txQuery;
  if (txErr) return { ok: false, error: txErr.message };
  if (!txs || txs.length === 0) {
    return {
      ok: true,
      scanned: 0,
      matched: 0,
      high_confidence: 0,
      medium_confidence: 0,
      low_confidence: 0,
    };
  }

  // 2. Build the candidate pool ONCE for the whole batch — bounded to the
  // date window of the imported transactions ±30 days.
  const dates = txs
    .map((t) => t.posted_at as string)
    .filter((d): d is string => Boolean(d))
    .sort();
  if (dates.length === 0) {
    return { ok: false, error: 'No transactions with valid dates to match.' };
  }
  const pool = await getMatchPool({ min_date: dates[0], max_date: dates[dates.length - 1] });

  // 3. Score each tx and stage the writes.
  let matched = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  const updates: Array<{
    id: string;
    match_status: 'suggested' | 'unmatched';
    match_confidence: 'high' | 'medium' | 'low' | null;
    match_score: number | null;
    match_candidates: unknown[];
  }> = [];

  for (const tx of txs) {
    const candidates = findMatchCandidates(
      {
        posted_at: tx.posted_at as string,
        amount_cents: tx.amount_cents as number,
        description: (tx.description as string) ?? '',
        description_normalized: normalize((tx.description as string) ?? ''),
      },
      pool,
    );

    if (candidates.length === 0) {
      updates.push({
        id: tx.id as string,
        match_status: 'unmatched',
        match_confidence: null,
        match_score: null,
        match_candidates: [],
      });
      continue;
    }

    matched++;
    if (candidates[0].confidence === 'high') high++;
    else if (candidates[0].confidence === 'medium') medium++;
    else low++;

    updates.push({
      id: tx.id as string,
      match_status: 'suggested',
      match_confidence: candidates[0].confidence,
      match_score: candidates[0].score,
      match_candidates: candidates,
    });
  }

  // 4. Persist. Supabase update doesn't accept array-of-different-rows in
  // one call without a CASE — we issue a query per row. Volumes are
  // bounded by BATCH_LIMIT and statement size, so this is fine for now.
  // If this ever feels slow we can switch to an RPC that takes a JSON
  // payload and applies via UPDATE FROM (jsonb_to_recordset(...)).
  const errs: string[] = [];
  for (const u of updates) {
    const { error } = await supabase
      .from('bank_transactions')
      .update({
        match_status: u.match_status,
        match_confidence: u.match_confidence,
        match_score: u.match_score,
        match_candidates: u.match_candidates,
      })
      .eq('id', u.id);
    if (error) errs.push(`${u.id}: ${error.message}`);
  }

  if (errs.length > 0) {
    return {
      ok: false,
      error: `Auto-match wrote ${updates.length - errs.length}/${updates.length} rows. First error: ${errs[0]}`,
    };
  }

  revalidatePath('/business-health');
  revalidatePath('/business-health/bank-import');

  return {
    ok: true,
    scanned: txs.length,
    matched,
    high_confidence: high,
    medium_confidence: medium,
    low_confidence: low,
  };
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
