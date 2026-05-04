/**
 * BR-5 — payment auto-detect engine.
 *
 * For each parsed bank_transaction, find candidate invoices / expenses /
 * bills and score them. Returns up to 3 ranked candidates per tx; anything
 * scoring below 30 is dropped (the "no match" pile, intentionally not our
 * problem — those are QBO's job).
 *
 * Strategic line: this is a *payment shortcut*, not a reconciliation
 * engine. We only try to match what could plausibly be an invoice payment
 * (positive bank tx) or an expense/bill payment (negative bank tx). We do
 * NOT try to handle transfers, fees, interest, or ATM withdrawals.
 *
 * Scoring rubric (max 100):
 *   - Amount: exact = 50, ±$0.01 = 50, ±$1 = 35, within 1% = 20
 *   - Date:   ±2 days = 30, ±5 days = 20, ±10 days = 10
 *   - Text:   substring match (vendor in desc) = 20,
 *             reverse substring = 15,
 *             Jaccard token overlap = 0..15
 *
 * Confidence:
 *   - ≥85 = high (auto-pre-checked in BR-7 review queue)
 *   - 60-84 = medium (suggested, not pre-checked)
 *   - 30-59 = low (shown but de-emphasized)
 *   - <30 = dropped, transaction stays 'unmatched'
 */

export const MIN_SCORE = 30;
export const HIGH_CONFIDENCE_THRESHOLD = 85;
export const MEDIUM_CONFIDENCE_THRESHOLD = 60;
export const MAX_CANDIDATES = 3;

export type MatchCandidate = {
  kind: 'invoice' | 'expense' | 'bill';
  id: string;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  amount_cents: number;
  tx_date: string;
  label: string;
};

export type MatchableInvoice = {
  id: string;
  /** Pre-tax + tax already summed by the caller. Always positive (money in). */
  amount_cents: number;
  sent_at: string | null;
  created_at: string;
  customer_name: string | null;
};

export type MatchableExpense = {
  id: string;
  /** Always positive in DB; we'll compare against |bank_tx_amount|. */
  amount_cents: number;
  expense_date: string;
  vendor: string | null;
  description: string | null;
};

export type MatchableBill = {
  id: string;
  /** Always positive. */
  amount_cents: number;
  bill_date: string;
  vendor: string;
  description: string | null;
};

export type MatchPool = {
  invoices: MatchableInvoice[];
  expenses: MatchableExpense[];
  bills: MatchableBill[];
};

export type BankTxForMatching = {
  posted_at: string; // YYYY-MM-DD
  /** Signed: negative = money out, positive = money in. */
  amount_cents: number;
  description: string;
  description_normalized: string;
};

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

export function findMatchCandidates(tx: BankTxForMatching, pool: MatchPool): MatchCandidate[] {
  const isInflow = tx.amount_cents > 0;
  const txMagnitude = Math.abs(tx.amount_cents);

  const candidates: MatchCandidate[] = [];

  if (isInflow) {
    for (const inv of pool.invoices) {
      const c = scoreInvoice(tx, txMagnitude, inv);
      if (c) candidates.push(c);
    }
  } else {
    for (const exp of pool.expenses) {
      const c = scoreExpense(tx, txMagnitude, exp);
      if (c) candidates.push(c);
    }
    for (const bill of pool.bills) {
      const c = scoreBill(tx, txMagnitude, bill);
      if (c) candidates.push(c);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_CANDIDATES);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreInvoice(
  tx: BankTxForMatching,
  txMagnitude: number,
  inv: MatchableInvoice,
): MatchCandidate | null {
  const amountScore = scoreAmount(txMagnitude, inv.amount_cents);
  if (amountScore === 0) return null;

  const candDate = inv.sent_at?.slice(0, 10) ?? inv.created_at.slice(0, 10);
  const dateScore = scoreDate(tx.posted_at, candDate);
  const textScore = scoreText(tx.description_normalized, inv.customer_name ?? '');

  const total = amountScore + dateScore + textScore;
  if (total < MIN_SCORE) return null;

  return {
    kind: 'invoice',
    id: inv.id,
    score: total,
    confidence: bucket(total),
    amount_cents: inv.amount_cents,
    tx_date: candDate,
    label: inv.customer_name ?? 'Customer',
  };
}

function scoreExpense(
  tx: BankTxForMatching,
  txMagnitude: number,
  exp: MatchableExpense,
): MatchCandidate | null {
  const amountScore = scoreAmount(txMagnitude, exp.amount_cents);
  if (amountScore === 0) return null;

  const dateScore = scoreDate(tx.posted_at, exp.expense_date);
  const vendorText = [exp.vendor, exp.description].filter(Boolean).join(' ');
  const textScore = scoreText(tx.description_normalized, vendorText);

  const total = amountScore + dateScore + textScore;
  if (total < MIN_SCORE) return null;

  return {
    kind: 'expense',
    id: exp.id,
    score: total,
    confidence: bucket(total),
    amount_cents: exp.amount_cents,
    tx_date: exp.expense_date,
    label: exp.vendor ?? exp.description ?? 'Expense',
  };
}

function scoreBill(
  tx: BankTxForMatching,
  txMagnitude: number,
  bill: MatchableBill,
): MatchCandidate | null {
  const amountScore = scoreAmount(txMagnitude, bill.amount_cents);
  if (amountScore === 0) return null;

  const dateScore = scoreDate(tx.posted_at, bill.bill_date);
  const vendorText = [bill.vendor, bill.description].filter(Boolean).join(' ');
  const textScore = scoreText(tx.description_normalized, vendorText);

  const total = amountScore + dateScore + textScore;
  if (total < MIN_SCORE) return null;

  return {
    kind: 'bill',
    id: bill.id,
    score: total,
    confidence: bucket(total),
    amount_cents: bill.amount_cents,
    tx_date: bill.bill_date,
    label: bill.vendor,
  };
}

// ---------------------------------------------------------------------------
// Component scorers (exported for unit tests)
// ---------------------------------------------------------------------------

export function scoreAmount(txMagnitude: number, candidateCents: number): number {
  if (candidateCents <= 0) return 0;
  const diff = Math.abs(txMagnitude - candidateCents);
  if (diff <= 1) return 50; // ±$0.01 — rounding
  if (diff <= 100) return 35; // ±$1 — typo / fee
  const ratio = diff / candidateCents;
  if (ratio <= 0.01) return 20; // within 1%
  return 0;
}

export function scoreDate(txDate: string, candidateDate: string): number {
  const days = daysBetween(txDate, candidateDate);
  if (days === null) return 0;
  if (days <= 2) return 30;
  if (days <= 5) return 20;
  if (days <= 10) return 10;
  return 0;
}

export function scoreText(txDescriptionNormalized: string, candidateLabel: string): number {
  const cand = normalize(candidateLabel);
  if (!cand || !txDescriptionNormalized) return 0;
  if (txDescriptionNormalized.includes(cand)) return 20;
  if (cand.includes(txDescriptionNormalized)) return 15;
  return Math.round(jaccardTokenOverlap(txDescriptionNormalized, cand) * 15);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bucket(score: number): 'high' | 'medium' | 'low' {
  if (score >= HIGH_CONFIDENCE_THRESHOLD) return 'high';
  if (score >= MEDIUM_CONFIDENCE_THRESHOLD) return 'medium';
  return 'low';
}

function daysBetween(a: string, b: string): number | null {
  const ad = Date.parse(`${a}T00:00:00Z`);
  const bd = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ad) || Number.isNaN(bd)) return null;
  return Math.abs(Math.round((ad - bd) / (1000 * 60 * 60 * 24)));
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccardTokenOverlap(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter(Boolean));
  const tb = new Set(b.split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}
