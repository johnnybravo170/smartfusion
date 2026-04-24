'use server';

/**
 * Bookkeeper chart-of-accounts upload + AI mapping.
 *
 * Flow:
 *   1. Upload a CSV of the accountant's chart of accounts (code + name,
 *      plus an optional type/description column).
 *   2. Parse to `{code, name}` rows.
 *   3. Run an OpenAI pass that, given the tenant's expense categories
 *      and the parsed accounts, suggests the best match for each
 *      category with a confidence score.
 *   4. Hand the suggestions back to the client; the operator/bookkeeper
 *      reviews and applies them individually or in bulk.
 *
 * MVP supports CSV only. XLSX can come later if anyone complains.
 */

import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const MAX_BYTES = 2 * 1024 * 1024; // 2MB is plenty for a COA

export type CoaRow = { code: string; name: string };

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
  | {
      ok: true;
      accounts: CoaRow[];
      suggestions: CoaSuggestion[];
    }
  | { ok: false; error: string };

/**
 * Minimal CSV parser: handles quoted fields + commas inside quotes.
 * Good enough for the shape accountants export. Skips empty rows.
 */
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
 * Heuristically pick the code + name columns. Looks at the header row
 * for common labels; if not present, falls back to: first numeric-ish
 * column = code, longest text column = name.
 */
function detectColumns(rows: string[][]): { codeIdx: number; nameIdx: number } | null {
  if (rows.length === 0) return null;
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const codeCandidates = ['code', 'account code', 'account #', 'number', 'account number', 'no.'];
  const nameCandidates = ['name', 'account', 'account name', 'description'];
  let codeIdx = header.findIndex((h) => codeCandidates.some((c) => h.includes(c)));
  let nameIdx = header.findIndex((h) => nameCandidates.some((c) => h.includes(c)));

  const hasHeader = codeIdx >= 0 || nameIdx >= 0;

  if (!hasHeader) {
    // No header row — guess from the data. Pick the column whose values
    // look most numeric as the code column, the one with the most text
    // as the name column.
    const sample = rows.slice(0, Math.min(10, rows.length));
    const scores = (sample[0] ?? []).map((_, i) => {
      let numeric = 0;
      let textLen = 0;
      for (const r of sample) {
        const v = (r[i] ?? '').trim();
        if (/^[0-9]+(-[0-9]+)*$/.test(v)) numeric++;
        textLen += v.length;
      }
      return { i, numeric, textLen };
    });
    scores.sort((a, b) => b.numeric - a.numeric);
    codeIdx = scores[0]?.i ?? 0;
    const textScores = scores.filter((s) => s.i !== codeIdx).sort((a, b) => b.textLen - a.textLen);
    nameIdx = textScores[0]?.i ?? 1;
  }

  if (codeIdx < 0 || nameIdx < 0 || codeIdx === nameIdx) return null;
  return { codeIdx, nameIdx };
}

/**
 * Parse the uploaded CSV and run an AI pass to suggest mappings. Does
 * NOT save — the UI shows suggestions, operator accepts per-row or
 * in bulk, then applyCoaMappingAction writes the codes.
 */
export async function analyzeCoaAction(formData: FormData): Promise<CoaMappingResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('coa');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded.' };
  }
  if (file.size > MAX_BYTES) return { ok: false, error: 'File is larger than 2MB.' };

  const text = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
  const rows = parseCsv(text);
  if (rows.length === 0) return { ok: false, error: 'File is empty.' };

  const cols = detectColumns(rows);
  if (!cols) {
    return {
      ok: false,
      error: "Couldn't detect code/name columns. Expected a CSV with 'code' and 'name' columns.",
    };
  }

  // Assume row 0 is a header if it contained any of our label candidates.
  const headerRow = rows[0].map((h) => h.toLowerCase().trim());
  const hasHeader =
    headerRow.includes('code') ||
    headerRow.includes('name') ||
    headerRow.some((h) => h.includes('account'));
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const accounts: CoaRow[] = dataRows
    .map((r) => ({
      code: (r[cols.codeIdx] ?? '').trim(),
      name: (r[cols.nameIdx] ?? '').trim(),
    }))
    .filter((a) => a.code.length > 0 && a.name.length > 0);

  if (accounts.length === 0) {
    return { ok: false, error: 'No valid rows found. Check your file.' };
  }

  // Pull the tenant's current categories (with current codes + parent names).
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

  // Skip parents with children — not mappable themselves.
  const mappable = categories.filter((c) => !c.isParentWithChildren);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY.' };

  const prompt = `You are mapping a contractor's expense categories to their bookkeeper's chart of accounts.

Categories to map (${mappable.length}):
${mappable.map((c) => `- ${c.id} :: ${c.label}${c.currentCode ? ` (already: ${c.currentCode})` : ''}`).join('\n')}

Chart of accounts (${accounts.length}):
${accounts.map((a) => `${a.code} — ${a.name}`).join('\n')}

For each category, pick the best-matching account code and name, or null if nothing fits well. Confidence: "high" if the names clearly align (e.g. "Fuel" → "Motor Vehicle - Fuel"), "medium" if a plausible guess, "low" if uncertain, null if no match. Reason: a short phrase why (max 10 words).`;

  let res: Response;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You return structured JSON only.' },
          { role: 'user', content: prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'coa_mapping',
            strict: true,
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
                    required: [
                      'category_id',
                      'suggested_code',
                      'suggested_name',
                      'confidence',
                      'reason',
                    ],
                  },
                },
              },
              required: ['mappings'],
            },
          },
        },
      }),
    });
  } catch (e) {
    return { ok: false, error: `Network: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { ok: false, error: `OpenAI ${res.status}: ${txt || res.statusText}` };
  }

  const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) return { ok: false, error: 'OpenAI returned no content.' };

  let parsed: {
    mappings: Array<{
      category_id: string;
      suggested_code: string | null;
      suggested_name: string | null;
      confidence: 'high' | 'medium' | 'low' | null;
      reason: string | null;
    }>;
  };
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'OpenAI returned non-JSON.' };
  }

  const byCatId = new Map(parsed.mappings.map((m) => [m.category_id, m]));
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
 * pairs — typically the user-accepted subset of the analyzeCoaAction
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
