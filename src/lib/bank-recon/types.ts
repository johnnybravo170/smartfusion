/**
 * Shared types for the bank-recon CSV parser. The parser's job is to take
 * a raw CSV file (whatever bank/card it came from) and produce a typed
 * `ParsedStatement` — enough context for the upload UI (BR-4) to render
 * a preview, plus a list of normalized transactions ready for import.
 *
 * The parser does NOT touch the database; it has no notion of tenants or
 * dedup hashes. Downstream callers compute those.
 */

import type { BankPreset } from '@/lib/db/schema/bank-statements';

export type DateFormat =
  | 'YYYY-MM-DD'
  | 'YYYY/MM/DD'
  | 'MM/DD/YYYY'
  | 'DD/MM/YYYY'
  | 'M/D/YYYY'
  | 'D/M/YYYY'
  | 'YYYYMMDD';

export type SignConvention =
  /** One signed numeric column. Negative = debit, positive = credit. */
  | { kind: 'signed_amount' }
  /** Two columns: debits column has positive numbers, credits column has positive numbers. We negate debits. */
  | { kind: 'separate_debit_credit'; debit_index: number; credit_index: number }
  /** All amounts positive. A flag column tells us debit vs credit. */
  | { kind: 'positive_with_flag'; flag_index: number; debit_value_pattern: RegExp };

export type ColumnMap = {
  date: number;
  description: number;
  /** Single signed-amount column. -1 if using debit/credit pair. */
  amount: number;
};

export type DetectionSource =
  | 'preset' // matched a known bank preset by characteristic header
  | 'header' // fuzzy match against header hints
  | 'content_shape' // last-resort: column shape (most numeric, most date-like, longest text)
  | 'manual'; // caller provided overrides

export type ParsedTransaction = {
  /** ISO date — YYYY-MM-DD. */
  posted_at: string;
  /** Signed cents. Negative = money out, positive = money in. */
  amount_cents: number;
  /** Original description string (whitespace-collapsed but otherwise as-shown). */
  description: string;
  /** Lowercased + alphanumeric-collapsed for matching. Stable across whitespace/punctuation. */
  description_normalized: string;
  /** Original row as a header→value map for debugging / round-tripping. */
  raw: Record<string, string>;
};

export type ParseWarning = {
  kind:
    | 'unparseable_row'
    | 'ambiguous_date'
    | 'unknown_encoding'
    | 'low_confidence_columns'
    | 'preset_partial_match';
  message: string;
  row_index?: number;
};

export type ParsedStatement = {
  detected_preset: BankPreset | null;
  detection_source: DetectionSource;
  column_map: ColumnMap;
  sign_convention: SignConvention;
  detected_date_format: DateFormat;
  encoding_fallback_used: boolean;
  confidence: 'high' | 'medium' | 'low';
  rows: ParsedTransaction[];
  /** First N rows (post-header) for the upload UI's preview table. */
  preview: { headers: string[]; sample: string[][] };
  warnings: ParseWarning[];
};

export type ParserOptions = {
  /** Used only for tagging warnings; doesn't affect parsing. */
  filename?: string;
  /** Skip detection and use this preset's column map. */
  preset_hint?: BankPreset;
  /** Override one or more detected columns. Used by the BR-4 manual-pick UI. */
  manual_overrides?: {
    date?: number;
    description?: number;
    amount?: number;
    debit?: number;
    credit?: number;
    date_format?: DateFormat;
  };
};

export type ParseResult = { ok: true; data: ParsedStatement } | { ok: false; error: string };
