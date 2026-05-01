/**
 * Fuzzy header-name matching. Each column we want to identify has an
 * array of header-string hints; we score each input header against the
 * hints and pick the highest-scoring column.
 *
 * Matching is intentionally loose:
 *  - case-insensitive
 *  - whitespace + punctuation collapsed
 *  - "contains" semantics (a header of "Posting Date" matches the hint
 *    "post date")
 *
 * We rank by (a) exact normalized match, then (b) hint-contained-in-header,
 * then (c) header-contained-in-hint, so "Date" beats "Date Posted" for a
 * generic "date" lookup but "Withdrawal Date" doesn't accidentally win
 * against "withdrawal".
 */

export const DATE_HEADER_HINTS = [
  'date',
  'posted',
  'posting',
  'transaction date',
  'trans date',
  'date posted',
  'effective',
  'value date',
  'process date',
];

export const DESCRIPTION_HEADER_HINTS = [
  'description',
  'details',
  'memo',
  'narrative',
  'merchant',
  'transaction',
  'particulars',
  'payee',
  'name',
];

export const AMOUNT_HEADER_HINTS = [
  'amount',
  'value',
  'cad',
  'cad$',
  'usd',
  '$',
  'transaction amount',
  'original amount',
  'total',
];

export const DEBIT_HEADER_HINTS = [
  'debit',
  'debits',
  'withdrawal',
  'withdrawals',
  'withdrawn',
  'paid out',
  'money out',
  'spent',
];

export const CREDIT_HEADER_HINTS = [
  'credit',
  'credits',
  'deposit',
  'deposits',
  'deposited',
  'paid in',
  'money in',
  'received',
];

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score a single header against an array of hints. Higher is better.
 * Returns 0 if no hint touches the header.
 */
function scoreHeader(header: string, hints: string[]): number {
  const h = normalize(header);
  if (!h) return 0;
  let best = 0;
  for (const raw of hints) {
    const hint = normalize(raw);
    if (!hint) continue;
    if (h === hint) best = Math.max(best, 100);
    else if (h.includes(hint)) best = Math.max(best, 70 - (h.length - hint.length));
    else if (hint.includes(h)) best = Math.max(best, 50 - (hint.length - h.length));
  }
  return best;
}

/**
 * Find the column whose header best matches the given hint set.
 * Returns -1 if no header scores at all (caller falls through to
 * content-shape detection).
 */
export function findHeaderColumn(
  headers: string[],
  hints: string[],
): { index: number; score: number } {
  let best = { index: -1, score: 0 };
  for (let i = 0; i < headers.length; i++) {
    const s = scoreHeader(headers[i] ?? '', hints);
    if (s > best.score) best = { index: i, score: s };
  }
  return best;
}
