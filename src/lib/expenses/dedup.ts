/**
 * Deterministic expense dedup for the bulk-receipt onboarding import.
 *
 * Receipts come from the wild (paper, e-mail, screenshots), so the
 * stable identifiers are weak. The most realistic match is:
 *
 *   - **vendor + amount + date within 3 days** — same vendor, same
 *     total cents, near-same date. High-confidence: a contractor
 *     doesn't spend the same amount at the same vendor twice in a
 *     6-day window without noticing.
 *
 * Looser matches (vendor-only, amount-only) are intentionally not
 * surfaced — duplicate receipts across batches are common and the
 * operator can roll back if they catch a misfire. False-positive
 * merges (collapsing two real expenses) are the more painful error.
 */

import { normalizeName } from '@/lib/customers/dedup';

export type ExpenseMatchTier = 'vendor+amount+date' | null;

export type ExistingExpense = {
  id: string;
  vendor: string | null;
  amount_cents: number;
  tax_cents: number;
  expense_date: string; // ISO date
};

export type ProposedExpense = {
  vendor: string | null;
  totalCents: number; // amount + tax
  expenseDateIso: string;
};

export type ExpenseDedupMatch = {
  tier: ExpenseMatchTier;
  existing: ExistingExpense | null;
};

const DAY_MS = 86_400_000;
const MATCH_WINDOW_DAYS = 3;

export function findExpenseMatch(
  proposed: ProposedExpense,
  existing: ExistingExpense[],
): ExpenseDedupMatch {
  if (!proposed.vendor) return { tier: null, existing: null };
  const proposedDate = new Date(proposed.expenseDateIso);
  if (Number.isNaN(proposedDate.getTime())) return { tier: null, existing: null };
  const proposedMs = proposedDate.getTime();
  const proposedVendor = normalizeName(proposed.vendor);

  for (const e of existing) {
    if (!e.vendor) continue;
    if (normalizeName(e.vendor) !== proposedVendor) continue;
    if (e.amount_cents + e.tax_cents !== proposed.totalCents) continue;
    const anchorMs = new Date(e.expense_date).getTime();
    if (Number.isNaN(anchorMs)) continue;
    if (Math.abs(anchorMs - proposedMs) <= MATCH_WINDOW_DAYS * DAY_MS) {
      return { tier: 'vendor+amount+date', existing: e };
    }
  }
  return { tier: null, existing: null };
}

export function expenseTierLabel(tier: ExpenseMatchTier): string {
  switch (tier) {
    case 'vendor+amount+date':
      return 'Same vendor + amount + date';
    default:
      return '';
  }
}
