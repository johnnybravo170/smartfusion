/**
 * CSV decoding + parsing for bank statements.
 *
 * Two layers:
 *  1. `decodeBuffer` — UTF-8 first, fall back to Windows-1252 if mojibake
 *     is detected. Many bank exports (especially QuickBooks-style and
 *     older RBC/CIBC dumps) come down as Win-1252.
 *  2. `parseCsv` — RFC 4180 with double-quote escaping + CRLF/LF tolerance.
 *     Self-contained (no dependency); same shape as the COA importer's
 *     parser but kept local so neither side has to import the other.
 */

const REPLACEMENT_CHAR = '�';

/**
 * Decode a binary buffer to a UTF-8 string. If the result contains the
 * Unicode replacement character (0xFFFD), assume the source was Win-1252
 * (a common Windows export encoding) and re-decode. Returns the chosen
 * encoding so callers can surface a warning when fallback kicks in.
 */
export function decodeBuffer(buf: Buffer | Uint8Array): {
  text: string;
  encoding: 'utf-8' | 'windows-1252';
} {
  const u8 =
    buf instanceof Buffer ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : buf;

  // Strip a UTF-8 BOM if present.
  let start = 0;
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) start = 3;

  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(start));
  if (!utf8.includes(REPLACEMENT_CHAR)) {
    return { text: utf8, encoding: 'utf-8' };
  }

  const win1252 = new TextDecoder('windows-1252').decode(u8.subarray(start));
  return { text: win1252, encoding: 'windows-1252' };
}

/**
 * Parse RFC 4180-flavored CSV. Handles quoted fields, escaped double-quotes,
 * mixed CR/LF/CRLF line endings, and skips blank lines.
 *
 * Returns rows as string[][] — no header treatment. Caller decides the
 * header row.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v.trim().length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }

  // Trailing field without newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((v) => v.trim().length > 0)) rows.push(row);
  }

  // Pad rows to a consistent column count — bank exports occasionally
  // emit rows with trailing-comma drops. Use the max observed width.
  const width = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) {
    while (r.length < width) r.push('');
  }

  return rows;
}
