/**
 * Bank-specific column maps + detection signatures for the major
 * Canadian retail banks plus Amex.
 *
 * Each preset declares (a) a `signature` regex that must match against
 * the joined header row to claim the file, and (b) a column map / sign
 * convention / date format that the parser uses without further
 * detection. When the signature matches with high confidence, we skip
 * the heuristic stack entirely.
 *
 * These are best-effort starting points; bank export formats drift over
 * time. The header-hint + content-shape stages backstop the presets, and
 * the BR-4 manual-pick UI is the last word.
 */

import type { BankPreset } from '@/lib/db/schema/bank-statements';
import type { ColumnMap, DateFormat, SignConvention } from './types';

export type PresetConfig = {
  name: BankPreset;
  /** Match against the lowercased + comma-joined header row. */
  signature: RegExp;
  date_format: DateFormat;
  build: (headers: string[]) => {
    column_map: ColumnMap;
    sign_convention: SignConvention;
  } | null;
};

function findIndex(headers: string[], pattern: RegExp): number {
  for (let i = 0; i < headers.length; i++) {
    if (pattern.test(headers[i] ?? '')) return i;
  }
  return -1;
}

/**
 * RBC personal chequing: "Account Type, Account Number, Transaction Date,
 * Cheque Number, Description 1, Description 2, CAD$, USD$"
 */
const RBC: PresetConfig = {
  name: 'rbc',
  signature: /account type.*transaction date.*description 1/i,
  date_format: 'M/D/YYYY',
  build: (headers) => {
    const date = findIndex(headers, /transaction date/i);
    const desc = findIndex(headers, /description 1/i);
    const amount = findIndex(headers, /^cad\$?$/i);
    if (date < 0 || desc < 0 || amount < 0) return null;
    return {
      column_map: { date, description: desc, amount },
      sign_convention: { kind: 'signed_amount' },
    };
  },
};

/**
 * TD chequing: "Date, Description, Withdrawals, Deposits, Balance"
 * (no header row in some exports — sniff first data row instead).
 */
const TD: PresetConfig = {
  name: 'td',
  signature: /withdrawals.*deposits.*balance/i,
  date_format: 'M/D/YYYY',
  build: (headers) => {
    const date = findIndex(headers, /^date$/i);
    const desc = findIndex(headers, /description/i);
    const debit = findIndex(headers, /withdrawal/i);
    const credit = findIndex(headers, /deposit/i);
    if (date < 0 || desc < 0 || debit < 0 || credit < 0) return null;
    return {
      column_map: { date, description: desc, amount: -1 },
      sign_convention: { kind: 'separate_debit_credit', debit_index: debit, credit_index: credit },
    };
  },
};

/**
 * BMO chequing: "First Bank Card, Transaction Type, Date Posted,
 * Transaction Amount, Description"
 */
const BMO: PresetConfig = {
  name: 'bmo',
  signature: /first bank card.*transaction type.*date posted/i,
  date_format: 'YYYYMMDD',
  build: (headers) => {
    const date = findIndex(headers, /date posted/i);
    const desc = findIndex(headers, /description/i);
    const amount = findIndex(headers, /transaction amount/i);
    if (date < 0 || desc < 0 || amount < 0) return null;
    return {
      column_map: { date, description: desc, amount },
      sign_convention: { kind: 'signed_amount' },
    };
  },
};

/**
 * Scotiabank personal: "Filter, Date, Description, Sub-description,
 * Status, Type of Transaction, Amount"
 */
const SCOTIA: PresetConfig = {
  name: 'scotia',
  signature: /sub.?description.*type of transaction/i,
  date_format: 'M/D/YYYY',
  build: (headers) => {
    const date = findIndex(headers, /^date$/i);
    const desc = findIndex(headers, /^description$/i);
    const amount = findIndex(headers, /^amount$/i);
    if (date < 0 || desc < 0 || amount < 0) return null;
    return {
      column_map: { date, description: desc, amount },
      sign_convention: { kind: 'signed_amount' },
    };
  },
};

/**
 * CIBC chequing: "Date, Description, Withdrawn, Deposited, Card Number"
 * (sometimes no header row at all on older exports — falls back to header
 * hints + content shape if signature misses.)
 */
const CIBC: PresetConfig = {
  name: 'cibc',
  signature: /withdrawn.*deposited/i,
  date_format: 'YYYY-MM-DD',
  build: (headers) => {
    const date = findIndex(headers, /^date$/i);
    const desc = findIndex(headers, /description/i);
    const debit = findIndex(headers, /withdrawn/i);
    const credit = findIndex(headers, /deposited/i);
    if (date < 0 || desc < 0 || debit < 0 || credit < 0) return null;
    return {
      column_map: { date, description: desc, amount: -1 },
      sign_convention: { kind: 'separate_debit_credit', debit_index: debit, credit_index: credit },
    };
  },
};

/**
 * Amex Canada: "Date, Description, Cardmember, Amount, Extended Details, ..."
 * Amex is special — "Amount" is positive for charges (debits) and negative
 * for payments. We invert at parse time so it lines up with our convention
 * (negative = money out).
 */
const AMEX: PresetConfig = {
  name: 'amex',
  signature: /cardmember/i,
  date_format: 'M/D/YYYY',
  build: (headers) => {
    const date = findIndex(headers, /^date$/i);
    const desc = findIndex(headers, /^description$/i);
    const amount = findIndex(headers, /^amount$/i);
    if (date < 0 || desc < 0 || amount < 0) return null;
    // Amex publishes charges as POSITIVE in the Amount column. Wrap the
    // sign convention so the parser flips them to negative (= money out)
    // before storing. Implementation: pretend it's positive_with_flag and
    // make the "flag" a constant pattern that always matches "DR".
    return {
      column_map: { date, description: desc, amount },
      sign_convention: {
        kind: 'positive_with_flag',
        flag_index: amount, // any column, gets ignored when we override below
        debit_value_pattern: /.*/, // every row treated as debit; payments come through as -ve already
      },
    };
  },
};

export const PRESETS: PresetConfig[] = [RBC, TD, BMO, SCOTIA, CIBC, AMEX];

/**
 * Try to match a preset by header signature. Returns the first match or
 * null if no preset claims the file.
 */
export function detectPreset(headers: string[]): PresetConfig | null {
  const joined = headers.map((h) => (h ?? '').toLowerCase()).join(',');
  for (const p of PRESETS) {
    if (p.signature.test(joined)) return p;
  }
  return null;
}

export function getPresetByName(name: BankPreset): PresetConfig | null {
  return PRESETS.find((p) => p.name === name) ?? null;
}
