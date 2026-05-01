/**
 * Main bank-statement parser. Orchestrates the redundancy stack:
 *
 *   1. Encoding: UTF-8 → Win-1252 fallback                  (csv.ts)
 *   2. Bank preset signature match                          (presets.ts)
 *   3. Header-hint fuzzy matching                           (header-hints.ts)
 *   4. Sign convention detection                            (sign-detection.ts)
 *   5. Date format detection                                (date-detection.ts)
 *   6. Content-shape fallback (numeric-most = amount, etc)  [inline below]
 *   7. Manual overrides                                     [inline below]
 *
 * Each layer can succeed independently; we walk them in order until we
 * have a complete column map + sign convention + date format. If the
 * deepest fallback still can't get us there, return ok: false and let
 * BR-3 (Gemini) or BR-4 (manual UI) take over.
 *
 * Caps: 5MB file, 5000 transaction rows. Above that we bail with a clear
 * error rather than silently truncating.
 */

import { decodeBuffer, parseCsv } from './csv';
import { detectDateFormat, parseDate } from './date-detection';
import {
  AMOUNT_HEADER_HINTS,
  CREDIT_HEADER_HINTS,
  DATE_HEADER_HINTS,
  DEBIT_HEADER_HINTS,
  DESCRIPTION_HEADER_HINTS,
  findHeaderColumn,
} from './header-hints';
import { detectPreset, getPresetByName } from './presets';
import { detectSignConvention, extractSignedCents, parseMoneyToCents } from './sign-detection';
import type {
  ColumnMap,
  DateFormat,
  DetectionSource,
  ParsedStatement,
  ParsedTransaction,
  ParseResult,
  ParserOptions,
  ParseWarning,
  SignConvention,
} from './types';

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const PREVIEW_ROWS = 10;

const DATE_SAMPLE_SIZE = 25;

export function parseBankStatement(
  buffer: Buffer | Uint8Array,
  opts: ParserOptions = {},
): ParseResult {
  if (buffer.byteLength === 0) {
    return { ok: false, error: 'Empty file.' };
  }
  if (buffer.byteLength > MAX_BYTES) {
    return { ok: false, error: 'Statement is larger than 5MB.' };
  }

  // 1. Encoding fallback
  const { text, encoding } = decodeBuffer(buffer);
  const encoding_fallback_used = encoding !== 'utf-8';

  // 2. CSV
  const allRows = parseCsv(text);
  if (allRows.length < 2) {
    return {
      ok: false,
      error: 'CSV has fewer than 2 rows; need at least a header + one transaction.',
    };
  }

  const headers = allRows[0];
  const dataRows = allRows.slice(1);
  if (dataRows.length > MAX_ROWS) {
    return {
      ok: false,
      error: `Statement has ${dataRows.length} transactions; max is ${MAX_ROWS}. Split the file.`,
    };
  }

  const warnings: ParseWarning[] = [];

  // 3. Detection
  const detected = detectColumns(headers, dataRows, opts, warnings);
  if (!detected) {
    return {
      ok: false,
      error:
        'Could not identify date / description / amount columns. Try a manual column override.',
    };
  }

  const {
    column_map,
    sign_convention,
    detected_date_format,
    detected_preset,
    detection_source,
    confidence,
  } = detected;

  // 4. Build typed transactions
  const rows: ParsedTransaction[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const dateRaw = row[column_map.date] ?? '';
    const descRaw = row[column_map.description] ?? '';

    const posted_at = parseDate(dateRaw, detected_date_format);
    if (!posted_at) {
      warnings.push({
        kind: 'unparseable_row',
        message: `Row ${i + 2}: could not parse date "${dateRaw}".`,
        row_index: i,
      });
      continue;
    }

    const amount_cents = extractSignedCents(row, column_map, sign_convention);
    if (amount_cents === null) {
      warnings.push({
        kind: 'unparseable_row',
        message: `Row ${i + 2}: could not parse amount.`,
        row_index: i,
      });
      continue;
    }

    const description = collapseWhitespace(descRaw);
    if (!description) {
      warnings.push({
        kind: 'unparseable_row',
        message: `Row ${i + 2}: empty description.`,
        row_index: i,
      });
      continue;
    }

    rows.push({
      posted_at,
      amount_cents,
      description,
      description_normalized: normalizeDescription(description),
      raw: rowToRecord(headers, row),
    });
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: 'No valid transactions parsed. Check the file or pick columns manually.',
    };
  }

  const data: ParsedStatement = {
    detected_preset,
    detection_source,
    column_map,
    sign_convention,
    detected_date_format,
    encoding_fallback_used,
    confidence,
    rows,
    preview: { headers, sample: dataRows.slice(0, PREVIEW_ROWS) },
    warnings,
  };

  return { ok: true, data };
}

// ---------------------------------------------------------------------------
// Detection cascade
// ---------------------------------------------------------------------------

type DetectionResult = {
  column_map: ColumnMap;
  sign_convention: SignConvention;
  detected_date_format: DateFormat;
  detected_preset: ParsedStatement['detected_preset'];
  detection_source: DetectionSource;
  confidence: 'high' | 'medium' | 'low';
};

function detectColumns(
  headers: string[],
  dataRows: string[][],
  opts: ParserOptions,
  warnings: ParseWarning[],
): DetectionResult | null {
  // ── Preset hint (caller forces a preset) ──
  if (opts.preset_hint) {
    const preset = getPresetByName(opts.preset_hint);
    const built = preset?.build(headers);
    if (preset && built) {
      const dateFmt =
        applyManualOverrides(built.column_map, opts).date_format ?? preset.date_format;
      return finalize(
        built.column_map,
        built.sign_convention,
        dateFmt,
        preset.name,
        'preset',
        'high',
        opts,
      );
    }
    warnings.push({
      kind: 'preset_partial_match',
      message: `Preset hint "${opts.preset_hint}" did not match this file's headers — falling through to detection.`,
    });
  }

  // ── Auto-detect preset by signature ──
  const preset = detectPreset(headers);
  const built = preset?.build(headers);
  if (preset && built) {
    return finalize(
      built.column_map,
      built.sign_convention,
      preset.date_format,
      preset.name,
      'preset',
      'high',
      opts,
    );
  }

  // ── Header hints ──
  const dateCol = findHeaderColumn(headers, DATE_HEADER_HINTS);
  const descCol = findHeaderColumn(headers, DESCRIPTION_HEADER_HINTS);
  const amountCol = findHeaderColumn(headers, AMOUNT_HEADER_HINTS);
  const debitCol = findHeaderColumn(headers, DEBIT_HEADER_HINTS);
  const creditCol = findHeaderColumn(headers, CREDIT_HEADER_HINTS);

  let column_map: ColumnMap | null = null;
  let sign_convention: SignConvention | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'medium';
  let source: DetectionSource = 'header';

  if (dateCol.index >= 0 && descCol.index >= 0) {
    if (debitCol.index >= 0 && creditCol.index >= 0 && debitCol.index !== creditCol.index) {
      column_map = { date: dateCol.index, description: descCol.index, amount: -1 };
      sign_convention = {
        kind: 'separate_debit_credit',
        debit_index: debitCol.index,
        credit_index: creditCol.index,
      };
    } else if (amountCol.index >= 0) {
      column_map = { date: dateCol.index, description: descCol.index, amount: amountCol.index };
      sign_convention = detectSignConvention(dataRows.slice(0, 50), {
        amount: amountCol.index,
      });
    }
    if (column_map && sign_convention) {
      const allHigh = dateCol.score >= 70 && descCol.score >= 70;
      confidence = allHigh ? 'high' : 'medium';
    }
  }

  // ── Content-shape fallback ──
  if (!column_map) {
    const shape = detectByContentShape(headers, dataRows);
    if (shape) {
      column_map = shape.column_map;
      sign_convention = shape.sign_convention;
      source = 'content_shape';
      confidence = 'low';
      warnings.push({
        kind: 'low_confidence_columns',
        message: 'Columns detected by content shape; verify in the preview before importing.',
      });
    }
  }

  if (!column_map || !sign_convention) return null;

  // ── Date format ──
  const sampleDates = dataRows.slice(0, DATE_SAMPLE_SIZE).map((r) => r[column_map.date] ?? '');
  const detection = detectDateFormat(sampleDates);
  if (!detection) return null;
  if (detection.ambiguous) {
    warnings.push({
      kind: 'ambiguous_date',
      message: `Date column is ambiguous between US and Canadian conventions. Defaulting to ${detection.format}.`,
    });
  }

  return finalize(column_map, sign_convention, detection.format, null, source, confidence, opts);
}

function detectByContentShape(
  headers: string[],
  dataRows: string[][],
): { column_map: ColumnMap; sign_convention: SignConvention } | null {
  const sample = dataRows.slice(0, 50);
  if (sample.length === 0 || headers.length === 0) return null;

  const colCount = headers.length;
  const numericScore = new Array(colCount).fill(0);
  const dateScore = new Array(colCount).fill(0);
  const lengthScore = new Array(colCount).fill(0);

  for (const row of sample) {
    for (let c = 0; c < colCount; c++) {
      const v = (row[c] ?? '').trim();
      if (!v) continue;
      if (parseMoneyToCents(v) !== null) numericScore[c]++;
      if (/^\d{1,4}[-/]\d{1,2}[-/]\d{1,4}$/.test(v) || /^\d{8}$/.test(v)) dateScore[c]++;
      lengthScore[c] += v.length;
    }
  }

  const date = argmax(dateScore);
  const amount = argmaxExcluding(numericScore, [date]);
  const description = argmaxExcluding(lengthScore, [date, amount]);
  if (date < 0 || amount < 0 || description < 0) return null;

  return {
    column_map: { date, description, amount },
    sign_convention: { kind: 'signed_amount' },
  };
}

function finalize(
  column_map: ColumnMap,
  sign_convention: SignConvention,
  date_format: DateFormat,
  preset: ParsedStatement['detected_preset'],
  source: DetectionSource,
  confidence: 'high' | 'medium' | 'low',
  opts: ParserOptions,
): DetectionResult {
  const overridden = applyManualOverrides(column_map, opts);
  return {
    column_map: overridden.column_map,
    sign_convention: overridden.sign_convention ?? sign_convention,
    detected_date_format: overridden.date_format ?? date_format,
    detected_preset: preset,
    detection_source: opts.manual_overrides ? 'manual' : source,
    confidence: opts.manual_overrides ? 'high' : confidence,
  };
}

function applyManualOverrides(
  column_map: ColumnMap,
  opts: ParserOptions,
): {
  column_map: ColumnMap;
  sign_convention?: SignConvention;
  date_format?: DateFormat;
} {
  const overrides = opts.manual_overrides;
  if (!overrides) return { column_map };

  const next: ColumnMap = {
    date: overrides.date ?? column_map.date,
    description: overrides.description ?? column_map.description,
    amount: overrides.amount ?? column_map.amount,
  };
  let sign_convention: SignConvention | undefined;
  if (overrides.debit !== undefined && overrides.credit !== undefined) {
    next.amount = -1;
    sign_convention = {
      kind: 'separate_debit_credit',
      debit_index: overrides.debit,
      credit_index: overrides.credit,
    };
  }
  return { column_map: next, sign_convention, date_format: overrides.date_format };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function argmax(arr: number[]): number {
  let best = -1;
  let bestVal = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > bestVal) {
      best = i;
      bestVal = arr[i];
    }
  }
  return best;
}

function argmaxExcluding(arr: number[], excluded: number[]): number {
  let best = -1;
  let bestVal = 0;
  for (let i = 0; i < arr.length; i++) {
    if (excluded.includes(i)) continue;
    if (arr[i] > bestVal) {
      best = i;
      bestVal = arr[i];
    }
  }
  return best;
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rowToRecord(headers: string[], row: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    const key = headers[i] || `col_${i}`;
    out[key] = row[i] ?? '';
  }
  return out;
}
