/**
 * Sign convention detection + amount extraction.
 *
 * Three conventions in the wild:
 *  1. `signed_amount` — one column with positive credits, negative debits.
 *     Detection: ≥1 negative value in a sample of N rows.
 *  2. `separate_debit_credit` — two columns, both holding positive numbers;
 *     debit-side rows have an empty credit cell and vice versa. We negate
 *     debits.
 *  3. `positive_with_flag` — one amount column (always positive) plus a
 *     type/flag column ("DR"/"CR", "Debit"/"Credit", etc). Less common
 *     but BMO has used variants.
 *
 * `parseMoneyToCents` is the workhorse — handles "$1,234.56", "(450.00)"
 * (accountant-style negative), "1,234.56-" (trailing-sign), embedded
 * currency codes, etc.
 */

import type { ColumnMap, SignConvention } from './types';

/**
 * Parse a money string to integer cents. Returns null on garbage. The
 * caller decides what to do with the sign — this just preserves whatever
 * was on the input (parens or leading minus → negative).
 */
export function parseMoneyToCents(raw: string): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // Accountant negatives: (1,234.56) → -1234.56
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // Trailing minus: "1,234.56-"
  if (s.endsWith('-')) {
    negative = true;
    s = s.slice(0, -1).trim();
  }

  // Strip currency markers, thousands separators, currency codes.
  s = s
    .replace(/[$£€¥]/g, '')
    .replace(/[,\s]/g, '')
    .replace(/(?:CAD|USD|EUR|GBP)$/i, '');

  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/**
 * Inspect a sample of rows for a single-amount column and return the
 * sign convention. (Two-column debit/credit is detected upstream by the
 * caller seeing both header types match.)
 */
export function detectSignConvention(sample: string[][], cols: { amount: number }): SignConvention {
  // Even one explicit negative confirms signed convention.
  let sawNegative = false;
  for (const row of sample) {
    const v = row[cols.amount];
    if (v == null) continue;
    const cents = parseMoneyToCents(v);
    if (cents !== null && cents < 0) {
      sawNegative = true;
      break;
    }
  }
  if (sawNegative) return { kind: 'signed_amount' };

  // No negatives in the sample. Could be all-positive credit-card style
  // (charges = positive) or could just be a chequing file with only
  // deposits in the sample. Default to signed_amount; downstream warning
  // surfaces when net cash flow looks wrong. The Amex preset overrides
  // this anyway.
  return { kind: 'signed_amount' };
}

/**
 * Pull a signed-cents amount out of a row using a column map + sign
 * convention. Returns null if the row's amount fields are unparseable.
 */
export function extractSignedCents(
  row: string[],
  column_map: ColumnMap,
  sign: SignConvention,
): number | null {
  switch (sign.kind) {
    case 'signed_amount': {
      const cents = parseMoneyToCents(row[column_map.amount]);
      return cents;
    }
    case 'separate_debit_credit': {
      const debit = parseMoneyToCents(row[sign.debit_index] ?? '');
      const credit = parseMoneyToCents(row[sign.credit_index] ?? '');
      // Pick whichever side has a non-zero value. If both populated
      // (rare/malformed), credit wins so we don't over-debit.
      if (credit !== null && credit !== 0) return Math.abs(credit);
      if (debit !== null && debit !== 0) return -Math.abs(debit);
      // Both empty/zero — explicit zero rows (like a balance roll-forward)
      // shouldn't fail parsing. Signal "no transaction" with null.
      return null;
    }
    case 'positive_with_flag': {
      const cents = parseMoneyToCents(row[column_map.amount]);
      if (cents === null) return null;
      const flag = row[sign.flag_index] ?? '';
      const isDebit = sign.debit_value_pattern.test(flag);
      return isDebit ? -Math.abs(cents) : Math.abs(cents);
    }
  }
}
