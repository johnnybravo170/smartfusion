'use server';

/**
 * BR-7 — confirm or reject suggested matches in bulk.
 *
 * `confirmBankMatchesAction` is the time-saver: take 50 suggested matches,
 * mark every targeted invoice / bill as paid in one DB round per kind,
 * stamp the bank_transactions as confirmed, leave a single summary
 * worklog entry. Per QBO_PLAN.md §1.5 — invoices flipping to paid here
 * trigger the existing Payment push to QBO (one fast-follow card to
 * verify end-to-end).
 *
 * `rejectBankMatchesAction` is the "this isn't an invoice" escape hatch.
 * The transaction stays in the DB for audit but never re-suggests.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import type { MatchCandidate } from '@/lib/bank-recon/matcher';
import { createClient } from '@/lib/supabase/server';

export type ConfirmBankMatchesResult =
  | {
      ok: true;
      confirmed: number;
      invoices_paid: number;
      bills_paid: number;
      expenses_linked: number;
      skipped: number;
    }
  | { ok: false; error: string };

export type RejectBankMatchesResult = { ok: true; rejected: number } | { ok: false; error: string };

const confirmSchema = z.object({
  bank_tx_id: z.string().uuid(),
  /** Which entry in `match_candidates` to confirm. 0 = best (default). */
  candidate_index: z.number().int().min(0).max(2).default(0),
});

const confirmBatchSchema = z.array(confirmSchema).min(1).max(500);

const rejectSchema = z.string().uuid();
const rejectBatchSchema = z.array(rejectSchema).min(1).max(500);

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

export async function confirmBankMatchesAction(
  matches: Array<{ bank_tx_id: string; candidate_index?: number }>,
): Promise<ConfirmBankMatchesResult> {
  const parsed = confirmBatchSchema.safeParse(
    matches.map((m) => ({ bank_tx_id: m.bank_tx_id, candidate_index: m.candidate_index ?? 0 })),
  );
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();

  const supabase = await createClient();

  // 1. Fetch the bank_transactions for the requested ids.
  const ids = parsed.data.map((m) => m.bank_tx_id);
  const { data: txs, error: txErr } = await supabase
    .from('bank_transactions')
    .select('id, posted_at, amount_cents, match_candidates, match_status')
    .in('id', ids);
  if (txErr) return { ok: false, error: txErr.message };
  const txById = new Map((txs ?? []).map((t) => [t.id as string, t]));

  // 2. For each match, resolve the chosen candidate from the stored list.
  type Resolved = {
    bank_tx_id: string;
    posted_at: string;
    candidate: MatchCandidate;
  };
  const resolved: Resolved[] = [];
  let skipped = 0;
  for (const m of parsed.data) {
    const tx = txById.get(m.bank_tx_id);
    if (!tx) {
      skipped++;
      continue;
    }
    if (tx.match_status !== 'suggested') {
      skipped++;
      continue;
    }
    const candidates = (tx.match_candidates as MatchCandidate[] | null) ?? [];
    const candidate = candidates[m.candidate_index];
    if (!candidate) {
      skipped++;
      continue;
    }
    resolved.push({
      bank_tx_id: tx.id as string,
      posted_at: tx.posted_at as string,
      candidate,
    });
  }

  if (resolved.length === 0) {
    return {
      ok: true,
      confirmed: 0,
      invoices_paid: 0,
      bills_paid: 0,
      expenses_linked: 0,
      skipped,
    };
  }

  // 3. Group by candidate kind for batched updates.
  const invoiceUpdates = resolved.filter((r) => r.candidate.kind === 'invoice');
  const billUpdates = resolved.filter((r) => r.candidate.kind === 'bill');
  const expenseUpdates = resolved.filter((r) => r.candidate.kind === 'expense');

  // 3a. Invoices → status='paid', paid_at = bank_tx.posted_at. Per-row
  //     update because paid_at differs per invoice. RLS keeps it tenant-
  //     scoped; we don't repeat the tenant filter explicitly.
  for (const u of invoiceUpdates) {
    const paidAtIso = `${u.posted_at}T12:00:00Z`;
    const { error } = await supabase
      .from('invoices')
      .update({
        status: 'paid',
        paid_at: paidAtIso,
        payment_method: 'other',
        payment_notes: 'Marked paid via bank statement reconciliation.',
        updated_at: new Date().toISOString(),
      })
      .eq('id', u.candidate.id)
      .eq('status', 'sent') // safety: don't clobber an invoice that flipped via another path
      .is('deleted_at', null);
    if (error) return { ok: false, error: `Invoice update failed: ${error.message}` };
  }

  // 3b. Bills → payment_status='paid' on the unified project_costs table.
  if (billUpdates.length > 0) {
    const billIds = billUpdates.map((u) => u.candidate.id);
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('project_costs')
      .update({ payment_status: 'paid', paid_at: now, updated_at: now })
      .in('id', billIds)
      .eq('source_type', 'vendor_bill')
      .eq('payment_status', 'unpaid');
    if (error) return { ok: false, error: `Bill update failed: ${error.message}` };
  }

  // 3c. Expenses don't have a status; just the bank_tx linkage below.

  // 4. Stamp bank_transactions. Receipts + vendor bills both live on
  //    project_costs now, so the two legacy columns (matched_expense_id,
  //    matched_bill_id) collapse into matched_cost_id; the candidate's
  //    `kind` discriminator survives indirectly via
  //    project_costs.source_type for any reader that needs it.
  const nowIso = new Date().toISOString();
  for (const r of resolved) {
    const matchedField =
      r.candidate.kind === 'invoice'
        ? { matched_invoice_id: r.candidate.id }
        : { matched_cost_id: r.candidate.id };
    const { error } = await supabase
      .from('bank_transactions')
      .update({
        match_status: 'confirmed',
        match_confidence: r.candidate.confidence,
        matched_at: nowIso,
        matched_by: user?.id ?? null,
        ...matchedField,
      })
      .eq('id', r.bank_tx_id);
    if (error) return { ok: false, error: `Bank tx update failed: ${error.message}` };
  }

  // 5. Single worklog summary instead of 50 rows of noise.
  await supabase.from('worklog_entries').insert({
    tenant_id: tenant.id,
    entry_type: 'system',
    title: `${resolved.length} bank match${resolved.length === 1 ? '' : 'es'} confirmed`,
    body:
      `Confirmed via bank reconciliation: ${invoiceUpdates.length} invoice(s) marked paid, ` +
      `${billUpdates.length} bill(s) marked paid, ${expenseUpdates.length} expense(s) linked.`,
  });

  revalidatePath('/business-health');
  revalidatePath('/business-health/bank-review');
  revalidatePath('/invoices');

  return {
    ok: true,
    confirmed: resolved.length,
    invoices_paid: invoiceUpdates.length,
    bills_paid: billUpdates.length,
    expenses_linked: expenseUpdates.length,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// Reject
// ---------------------------------------------------------------------------

export async function rejectBankMatchesAction(ids: string[]): Promise<RejectBankMatchesResult> {
  const parsed = rejectBatchSchema.safeParse(ids);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('bank_transactions')
    .update({ match_status: 'rejected' })
    .in('id', parsed.data)
    .in('match_status', ['suggested', 'unmatched'])
    .select('id');
  if (error) return { ok: false, error: error.message };

  revalidatePath('/business-health/bank-review');
  return { ok: true, rejected: data?.length ?? 0 };
}
