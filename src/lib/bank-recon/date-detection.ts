/**
 * Detect a column's date format from a sample of values, then parse
 * arbitrary strings against the chosen format.
 *
 * Bank CSVs are inconsistently dated — even within a single bank, exports
 * differ by region and product line. We try a curated list of formats
 * against ≥10 sample rows and pick the one with the best parse rate.
 *
 * When two formats parse equally well (the classic "is 03/04/2026 March
 * 4 or April 3?" problem), we prefer Canadian conventions: ISO first,
 * then DD/MM, then MM/DD. Callers can override via manual_overrides.
 */

import type { DateFormat } from './types';

const CANDIDATES: DateFormat[] = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'DD/MM/YYYY',
  'D/M/YYYY',
  'MM/DD/YYYY',
  'M/D/YYYY',
];

const PATTERNS: Record<DateFormat, RegExp> = {
  'YYYY-MM-DD': /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  'YYYY/MM/DD': /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/,
  YYYYMMDD: /^(\d{4})(\d{2})(\d{2})$/,
  'DD/MM/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'D/M/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  'MM/DD/YYYY': /^(\d{2})\/(\d{2})\/(\d{4})$/,
  'M/D/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
};

function extract(format: DateFormat, raw: string): { y: number; m: number; d: number } | null {
  const m = PATTERNS[format].exec(raw.trim());
  if (!m) return null;
  let y: number;
  let mo: number;
  let d: number;
  switch (format) {
    case 'YYYY-MM-DD':
    case 'YYYY/MM/DD':
    case 'YYYYMMDD':
      y = +m[1];
      mo = +m[2];
      d = +m[3];
      break;
    case 'DD/MM/YYYY':
    case 'D/M/YYYY':
      d = +m[1];
      mo = +m[2];
      y = +m[3];
      break;
    case 'MM/DD/YYYY':
    case 'M/D/YYYY':
      mo = +m[1];
      d = +m[2];
      y = +m[3];
      break;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return null;
  return { y, m: mo, d };
}

/**
 * Parse a single date string against a known format and return ISO
 * (YYYY-MM-DD). Returns null if unparseable.
 */
export function parseDate(raw: string, format: DateFormat): string | null {
  const parts = extract(format, raw);
  if (!parts) return null;
  return `${String(parts.y).padStart(4, '0')}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

export type DateDetection = {
  format: DateFormat;
  parse_rate: number;
  ambiguous: boolean;
};

/**
 * Detect a date format from a column of sample values. Returns the
 * highest parse-rate candidate; flags `ambiguous` when two formats tie
 * (the DD vs MM ambiguity in particular).
 */
export function detectDateFormat(samples: string[]): DateDetection | null {
  const cleaned = samples.map((s) => (s ?? '').trim()).filter((s) => s.length > 0);
  if (cleaned.length === 0) return null;

  const scores: Array<{ format: DateFormat; parsed: number; disambiguating: number }> = [];
  for (const fmt of CANDIDATES) {
    let parsed = 0;
    let disambiguating = 0;
    for (const s of cleaned) {
      const x = extract(fmt, s);
      if (!x) continue;
      parsed++;
      // Days > 12 disambiguate DD/MM vs MM/DD.
      if (x.d > 12) disambiguating++;
    }
    if (parsed > 0) scores.push({ format: fmt, parsed, disambiguating });
  }
  if (scores.length === 0) return null;

  // Highest parse rate wins; ties broken by disambiguating samples.
  scores.sort((a, b) => {
    if (a.parsed !== b.parsed) return b.parsed - a.parsed;
    return b.disambiguating - a.disambiguating;
  });
  const best = scores[0];

  // Ambiguity check: any other format that parses every sample best parses,
  // and whose ordering disagrees with the winner, marks the result ambiguous.
  const isDayMonth = best.format === 'DD/MM/YYYY' || best.format === 'D/M/YYYY';
  const isMonthDay = best.format === 'MM/DD/YYYY' || best.format === 'M/D/YYYY';
  const ambiguous =
    (isDayMonth || isMonthDay) &&
    best.disambiguating === 0 &&
    scores.some((s) => s !== best && s.parsed === best.parsed);

  return {
    format: best.format,
    parse_rate: best.parsed / cleaned.length,
    ambiguous,
  };
}
