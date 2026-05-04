'use server';

/**
 * Bookkeeper chart-of-accounts upload + AI mapping.
 *
 * Flow:
 *   1. Upload a CSV or XLSX of the accountant's chart of accounts.
 *   2. `parseCoaFileAction` ingests it: detects encoding (UTF-8 / win-1252),
 *      detects code + name columns via a cascade
 *      (heuristic → code-from-name parser → AI), returns a preview.
 *   3. UI surfaces the detected columns; user confirms or overrides.
 *   4. `runCoaMappingAction` takes the confirmed `{code, name}` rows and
 *      runs an OpenAI pass that suggests the best account match for
 *      each tenant expense category.
 *   5. Operator reviews and applies suggestions one or many at a time.
 *
 * Onboarding philosophy: failing to import is a churn risk. We try hard
 * to figure it out, and when we can't we always fall through to a
 * column-pick UI rather than tossing the user back to a toast.
 */

import * as XLSX from 'xlsx';
import { z } from 'zod';
import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const MAX_BYTES = 5 * 1024 * 1024; // 5MB — XLSX runs bigger than CSV
const PREVIEW_ROWS = 10;

export type CoaRow = { code: string; name: string };

export type DetectionSource = 'header' | 'code-from-name' | 'fallback' | 'manual' | 'none';

export type CoaParsePreview = {
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
  detectedCodeIdx: number | null;
  detectedNameIdx: number | null;
  detectionSource: DetectionSource;
  detectionConfidence: 'high' | 'medium' | 'low';
  /** True when the name column embeds the code (e.g. "1010 — CCS Savings"). */
  codeFromName: boolean;
  encodingFallbackUsed: boolean;
  fileType: 'csv' | 'xlsx';
};

export type CoaParseResult =
  | { ok: true; allRows: string[][]; hasHeader: boolean; preview: CoaParsePreview }
  | { ok: false; error: string };

export type CoaSuggestion = {
  categoryId: string;
  categoryLabel: string;
  currentCode: string | null;
  suggestedCode: string | null;
  suggestedName: string | null;
  confidence: 'high' | 'medium' | 'low' | null;
  reason: string | null;
};

export type CoaMappingResult =
  | { ok: true; accounts: CoaRow[]; suggestions: CoaSuggestion[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

function parseCsv(text: string): string[][] {
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
    } else if (c === '"') {
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
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((v) => v.trim().length > 0)) rows.push(row);
  }
  return rows;
}

/**
 * Decode CSV bytes. Tries UTF-8 first; if the result contains the Unicode
 * replacement character, retries as windows-1252 (the default encoding
 * for QuickBooks Desktop CSV exports on Windows).
 */
function decodeCsv(buf: ArrayBuffer): { text: string; fallbackUsed: boolean } {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!utf8.includes('�')) return { text: utf8, fallbackUsed: false };
  // Mojibake detected — re-decode as windows-1252.
  const win1252 = new TextDecoder('windows-1252').decode(buf);
  return { text: win1252, fallbackUsed: true };
}

// ---------------------------------------------------------------------------
// XLSX parsing
// ---------------------------------------------------------------------------

function parseXlsx(buf: ArrayBuffer): string[][] {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return [];
  const raw = XLSX.utils.sheet_to_json<Array<string | number | boolean | null>>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  });
  return raw.map((row) => row.map((cell) => (cell == null ? '' : String(cell))));
}

// ---------------------------------------------------------------------------
// Column detection cascade
// ---------------------------------------------------------------------------

const CODE_HEADER_HINTS = [
  'code',
  'acct',
  'account #',
  'account no',
  'account number',
  'accnt',
  'a/c',
  'gl',
  'gl code',
  'number',
  'no.',
  'no ',
];

const NAME_HEADER_HINTS = ['name', 'account', 'description', 'title'];

/** Strip dots, extra whitespace, lowercase. "Accnt. #" → "accnt #". */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

function detectByHeader(rows: string[][]): {
  codeIdx: number;
  nameIdx: number;
  confidence: 'high' | 'medium' | 'low';
} | null {
  if (rows.length === 0) return null;
  const header = rows[0].map(normalizeHeader);
  const codeIdx = header.findIndex((h) => h && CODE_HEADER_HINTS.some((c) => h.includes(c)));
  const nameIdx = header.findIndex((h) => h && NAME_HEADER_HINTS.some((c) => h.includes(c)));
  if (codeIdx >= 0 && nameIdx >= 0 && codeIdx !== nameIdx) {
    return { codeIdx, nameIdx, confidence: 'high' };
  }
  return null;
}

/**
 * QuickBooks Desktop and many Sage exports embed the code inside the
 * name column ("1010 — CCS Savings"). When we found a name column but
 * no code column, see whether the name field reliably starts with a
 * numeric/code-shaped token. Returns a synthesised codeIdx === -1
 * sentinel meaning "use the parser when extracting accounts".
 */
function detectCodeFromName(
  rows: string[][],
  nameIdx: number,
  hasHeader: boolean,
): { confidence: 'high' | 'medium' | 'low' } | null {
  const dataRows = hasHeader ? rows.slice(1) : rows;
  if (dataRows.length === 0) return null;
  const sample = dataRows.slice(0, 20);
  let hits = 0;
  for (const r of sample) {
    const v = (r[nameIdx] ?? '').trim();
    if (CODE_PREFIX_RE.test(v)) hits++;
  }
  const ratio = hits / sample.length;
  if (ratio >= 0.8) return { confidence: 'high' };
  if (ratio >= 0.5) return { confidence: 'medium' };
  return null;
}

/**
 * Match a leading code token in a name field. Accepts digits with
 * optional dots/dashes, then a separator (em-dash, en-dash, hyphen, or
 * the windows-1252 mojibake `�`), then the rest.
 */
const CODE_PREFIX_RE = /^([0-9][\w.-]*)\s*[—–\-�]\s*(.+)$/;

/** Last-resort: numeric-most column = code, longest text column = name. */
function detectByContentShape(rows: string[][]): {
  codeIdx: number;
  nameIdx: number;
  confidence: 'medium' | 'low';
} | null {
  if (rows.length === 0) return null;
  const sample = rows.slice(0, Math.min(10, rows.length));
  const cols = (sample[0] ?? []).length;
  if (cols < 2) return null;
  const scores = Array.from({ length: cols }, (_, i) => {
    let numeric = 0;
    let textLen = 0;
    for (const r of sample) {
      const v = (r[i] ?? '').trim();
      if (/^[0-9]+([.-][0-9]+)*$/.test(v)) numeric++;
      textLen += v.length;
    }
    return { i, numeric, textLen };
  });
  const sortedNumeric = [...scores].sort((a, b) => b.numeric - a.numeric);
  const codeIdx = sortedNumeric[0]?.numeric > 0 ? sortedNumeric[0].i : -1;
  if (codeIdx < 0) return null;
  const sortedText = scores.filter((s) => s.i !== codeIdx).sort((a, b) => b.textLen - a.textLen);
  const nameIdx = sortedText[0]?.i ?? -1;
  if (nameIdx < 0) return null;
  return { codeIdx, nameIdx, confidence: 'low' };
}

function looksLikeHeaderRow(row: string[]): boolean {
  // No raw numbers, mostly text.
  return row.every((v) => v.trim() === '' || !/^-?\d+(\.\d+)?$/.test(v.trim()));
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

export async function parseCoaFileAction(formData: FormData): Promise<CoaParseResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('coa');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded.' };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, error: `File is larger than ${MAX_BYTES / 1024 / 1024}MB.` };
  }

  const buf = await file.arrayBuffer();
  const lowerName = file.name.toLowerCase();
  const isXlsx =
    lowerName.endsWith('.xlsx') ||
    lowerName.endsWith('.xlsm') ||
    lowerName.endsWith('.xls') ||
    file.type.includes('spreadsheet') ||
    file.type.includes('excel');

  let rows: string[][];
  let fileType: 'csv' | 'xlsx';
  let encodingFallbackUsed = false;

  if (isXlsx) {
    fileType = 'xlsx';
    try {
      rows = parseXlsx(buf);
    } catch (e) {
      return {
        ok: false,
        error: `Couldn't read spreadsheet: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else {
    fileType = 'csv';
    const decoded = decodeCsv(buf);
    encodingFallbackUsed = decoded.fallbackUsed;
    rows = parseCsv(decoded.text);
  }

  if (rows.length === 0) return { ok: false, error: 'File is empty.' };

  const hasHeader = looksLikeHeaderRow(rows[0]);
  const headers = hasHeader
    ? rows[0].map((h) => h.trim())
    : rows[0].map((_, i) => `Column ${i + 1}`);

  // ---- detection cascade ---------------------------------------------------
  let detectedCodeIdx: number | null = null;
  let detectedNameIdx: number | null = null;
  let detectionSource: DetectionSource = 'none';
  let detectionConfidence: 'high' | 'medium' | 'low' = 'low';
  let codeFromName = false;

  if (hasHeader) {
    const byHeader = detectByHeader(rows);
    if (byHeader) {
      detectedCodeIdx = byHeader.codeIdx;
      detectedNameIdx = byHeader.nameIdx;
      detectionSource = 'header';
      detectionConfidence = byHeader.confidence;
    }
  }

  if (detectedNameIdx == null && hasHeader) {
    // Found a name-ish header but no code-ish header? Try code-from-name.
    const header = rows[0].map(normalizeHeader);
    const nameIdx = header.findIndex((h) => h && NAME_HEADER_HINTS.some((c) => h.includes(c)));
    if (nameIdx >= 0) {
      const cfn = detectCodeFromName(rows, nameIdx, true);
      if (cfn) {
        detectedCodeIdx = -1;
        detectedNameIdx = nameIdx;
        detectionSource = 'code-from-name';
        detectionConfidence = cfn.confidence;
        codeFromName = true;
      }
    }
  }

  if (detectedNameIdx == null) {
    const shape = detectByContentShape(rows);
    if (shape) {
      detectedCodeIdx = shape.codeIdx;
      detectedNameIdx = shape.nameIdx;
      detectionSource = 'fallback';
      detectionConfidence = shape.confidence;
    }
  }

  // No AI fallback — when heuristics fail, we surface the raw preview to
  // the UI and let the user pick columns manually. Cheap, predictable,
  // and the user is in the best position to decide on weird files.

  const sampleRows = (hasHeader ? rows.slice(1) : rows).slice(0, PREVIEW_ROWS);

  return {
    ok: true,
    allRows: rows,
    hasHeader,
    preview: {
      headers,
      sampleRows,
      totalRows: hasHeader ? rows.length - 1 : rows.length,
      detectedCodeIdx,
      detectedNameIdx,
      detectionSource,
      detectionConfidence,
      codeFromName,
      encodingFallbackUsed,
      fileType,
    },
  };
}

const RUN_MAPPING_INPUT = z.object({
  accounts: z
    .array(z.object({ code: z.string().min(1).max(80), name: z.string().min(1).max(500) }))
    .min(1)
    .max(2000),
});

export async function runCoaMappingAction(input: {
  accounts: CoaRow[];
}): Promise<CoaMappingResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = RUN_MAPPING_INPUT.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid accounts list.' };
  const accounts = parsed.data.accounts;

  const admin = createAdminClient();
  const { data: catRows, error: catErr } = await admin
    .from('expense_categories')
    .select('id, parent_id, name, account_code')
    .eq('tenant_id', tenant.id)
    .is('archived_at', null)
    .order('display_order', { ascending: true });
  if (catErr) return { ok: false, error: catErr.message };

  const byId = new Map<string, { id: string; parent_id: string | null; name: string }>();
  for (const r of catRows ?? []) {
    byId.set(r.id as string, r as never);
  }
  const categories = (catRows ?? []).map((r) => {
    const row = r as {
      id: string;
      parent_id: string | null;
      name: string;
      account_code: string | null;
    };
    const hasChildren = (catRows ?? []).some(
      (x) => (x as { parent_id: string | null }).parent_id === row.id,
    );
    return {
      id: row.id,
      label: row.parent_id ? `${byId.get(row.parent_id)?.name ?? '?'} › ${row.name}` : row.name,
      currentCode: row.account_code,
      isParentWithChildren: hasChildren,
    };
  });

  const mappable = categories.filter((c) => !c.isParentWithChildren);

  const prompt = `You are mapping a contractor's expense categories to their bookkeeper's chart of accounts.

Categories to map (${mappable.length}):
${mappable.map((c) => `- ${c.id} :: ${c.label}${c.currentCode ? ` (already: ${c.currentCode})` : ''}`).join('\n')}

Chart of accounts (${accounts.length}):
${accounts.map((a) => `${a.code} — ${a.name}`).join('\n')}

For each category, pick the best-matching account code and name, or null if nothing fits well. Confidence: "high" if the names clearly align (e.g. "Fuel" → "Motor Vehicle - Fuel"), "medium" if a plausible guess, "low" if uncertain, null if no match. Reason: a short phrase why (max 10 words).`;

  type ParsedMap = {
    mappings: Array<{
      category_id: string;
      suggested_code: string | null;
      suggested_name: string | null;
      confidence: 'high' | 'medium' | 'low' | null;
      reason: string | null;
    }>;
  };

  let parsedMap: ParsedMap;
  try {
    const res = await gateway().runStructured<ParsedMap>({
      kind: 'structured',
      task: 'coa_account_suggest',
      tenant_id: tenant.id,
      prompt,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mappings: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category_id: { type: 'string' },
                suggested_code: { type: ['string', 'null'] },
                suggested_name: { type: ['string', 'null'] },
                confidence: {
                  type: ['string', 'null'],
                  enum: ['high', 'medium', 'low', null],
                },
                reason: { type: ['string', 'null'] },
              },
              required: ['category_id', 'suggested_code', 'suggested_name', 'confidence', 'reason'],
            },
          },
        },
        required: ['mappings'],
      },
    });
    parsedMap = res.data;
  } catch (err) {
    if (isAiError(err)) {
      if (err.kind === 'quota')
        return { ok: false, error: 'AI mapping is temporarily unavailable across providers.' };
      if (err.kind === 'overload' || err.kind === 'rate_limit')
        return { ok: false, error: 'AI mapping is busy right now. Try again in a moment.' };
    }
    return { ok: false, error: 'AI mapping failed. Try again.' };
  }

  const byCatId = new Map(parsedMap.mappings.map((m) => [m.category_id, m]));
  const suggestions: CoaSuggestion[] = categories.map((c) => {
    const m = byCatId.get(c.id);
    return {
      categoryId: c.id,
      categoryLabel: c.label,
      currentCode: c.currentCode,
      suggestedCode: m?.suggested_code ?? null,
      suggestedName: m?.suggested_name ?? null,
      confidence: m?.confidence ?? null,
      reason: m?.reason ?? null,
    };
  });

  return { ok: true, accounts, suggestions };
}

/**
 * Apply accepted mappings. Input is a list of {category_id, account_code}
 * pairs — typically the user-accepted subset of the runCoaMappingAction
 * suggestions (with any manual edits).
 */
export async function applyCoaMappingAction(input: {
  mappings: Array<{ category_id: string; account_code: string | null }>;
}): Promise<{ ok: true; updated: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = z
    .object({
      mappings: z.array(
        z.object({
          category_id: z.string().uuid(),
          account_code: z.string().trim().max(40).nullable(),
        }),
      ),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const admin = createAdminClient();
  let updated = 0;
  for (const m of parsed.data.mappings) {
    const { error } = await admin
      .from('expense_categories')
      .update({
        account_code: m.account_code || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', m.category_id)
      .eq('tenant_id', tenant.id);
    if (error) return { ok: false, error: error.message };
    updated++;
  }
  return { ok: true, updated };
}
