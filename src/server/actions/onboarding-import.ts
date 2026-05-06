'use server';

/**
 * Henry-powered onboarding import. Phase A: customers.
 *
 * Three actions, mirroring the wizard's three steps:
 *   1. parseCustomerImportAction — operator drops a file or paste; Henry
 *      classifies it into a customer roster; we run dedup against the
 *      tenant's existing customers and return a preview.
 *   2. commitCustomerImportAction — operator approves the preview (with
 *      any edits); we create an import_batch row and bulk-insert the
 *      new customers tagged with import_batch_id.
 *   3. rollbackCustomerImportAction — admin op; deletes every customer
 *      tagged with the batch_id and marks the batch row rolled-back.
 *
 * The preview state is intentionally ephemeral (round-tripped through
 * the client) — there is no staging table. This matches the codebase
 * convention (CoA import, scope scaffold) and keeps the data flow
 * simple. For larger imports later we may add a staging table, but
 * Phase A's volumes (50–500 customers) don't warrant it.
 *
 * See:
 *   - kanban "Henry-powered onboarding import wizard"
 *   - migration 0185_import_batches.sql
 *   - src/lib/customers/dedup.ts
 *   - PATTERNS.md §15 (duplicate detection contract)
 */

import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import {
  type DedupTier,
  type ExistingCustomer,
  findMatch,
  type ProposedCustomer,
  tierLabel,
} from '@/lib/customers/dedup';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const MAX_PASTE_BYTES = 1 * 1024 * 1024; // 1MB hard cap on paste/file content

// ─── Parse: file/paste → proposed customers ──────────────────────────────────

export type ImportProposalRow = {
  /** Stable row id within the preview, so the client can edit individual
   *  rows without conflating positions. */
  rowKey: string;
  proposed: ProposedCustomer & {
    type?: 'residential' | 'commercial' | null;
    addressLine1?: string | null;
    province?: string | null;
    postalCode?: string | null;
    notes?: string | null;
  };
  match: {
    tier: DedupTier;
    label: string;
    existingId: string | null;
    existingName: string | null;
  };
};

export type ParseImportResult =
  | {
      ok: true;
      sourceFilename: string | null;
      sourceStoragePath: string | null;
      rows: ImportProposalRow[];
      summary: { proposed: number; matched: number };
    }
  | { ok: false; error: string };

const CUSTOMER_PARSE_PROMPT = `You are reading a list of customers a Canadian renovation contractor wants to import into a new tool. The input may be a CSV export from QuickBooks/Jobber/Houzz/Excel, or a plain text list, or a copy-paste from anywhere. Extract one row per customer.

Rules:
- Each row is ONE customer.
- "name" is required. If you can't read a confident name, skip the row entirely — don't guess.
- Phone numbers: keep as written; do NOT reformat.
- Email: lowercase, trimmed. null if not present.
- Address: split into street (address_line1), city, province (2-letter Canadian: BC/AB/ON/etc.), postal_code. Drop anything you can't parse cleanly into null rather than guessing.
- "type": "residential" if homeowner-looking; "commercial" if it's a business / strata / property mgmt. null if ambiguous.
- "notes": one short line of anything else interesting on the row that didn't fit a structured field — DO NOT pad with filler. null if the row had nothing extra.

Return ONLY JSON matching the schema. No prose, no markdown, no explanation.`;

const CUSTOMER_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    customers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          address_line1: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          province: { type: ['string', 'null'] },
          postal_code: { type: ['string', 'null'] },
          type: { type: ['string', 'null'], enum: ['residential', 'commercial', null] },
          notes: { type: ['string', 'null'] },
        },
        required: ['name'],
      },
    },
  },
  required: ['customers'],
};

type RawProposedCustomer = {
  name: unknown;
  email?: unknown;
  phone?: unknown;
  address_line1?: unknown;
  city?: unknown;
  province?: unknown;
  postal_code?: unknown;
  type?: unknown;
  notes?: unknown;
};

function userSafeError(err: unknown): string {
  if (isAiError(err)) {
    if (err.kind === 'quota')
      return 'Henry is temporarily unavailable. Please try again in a few minutes.';
    if (err.kind === 'overload' || err.kind === 'rate_limit')
      return 'Henry is busy right now. Please try again in a moment.';
    if (err.kind === 'timeout') return 'That took too long. Try with fewer rows or split the file.';
  }
  return 'Could not parse the file. Try pasting a smaller sample or a different format.';
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Parse a customer-list file (CSV/text) or paste into proposed rows.
 *
 * Either pass `formData.get('file')` as an uploaded File, or
 * `formData.get('text')` as a pasted string. Exactly one is required.
 */
export async function parseCustomerImportAction(formData: FormData): Promise<ParseImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('file');
  const text = formData.get('text');

  let payload: string;
  let sourceFilename: string | null = null;
  let sourceStoragePath: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_PASTE_BYTES) {
      return { ok: false, error: 'File is larger than 1MB. Try splitting it up.' };
    }
    sourceFilename = file.name;
    const buf = Buffer.from(await file.arrayBuffer());
    // We treat the upload as text — CSV / TSV / plain. Excel binary
    // (.xlsx) is not yet supported in Phase A; the operator can paste
    // the rows as text for now.
    payload = buf.toString('utf8');

    // Stash the original file in the `imports` bucket so we can
    // re-run / debug later. Use admin client so RLS doesn't trip on
    // the path-derived tenant check before we've inserted any row.
    const admin = createAdminClient();
    const stamp = Date.now();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    sourceStoragePath = `${tenant.id}/${stamp}-${safeName}`;
    const { error: uploadErr } = await admin.storage
      .from('imports')
      .upload(sourceStoragePath, buf, { contentType: file.type || 'text/plain' });
    if (uploadErr) {
      // Non-fatal — we can still classify even if we couldn't archive.
      console.error('[onboarding-import] source archive failed:', uploadErr.message);
      sourceStoragePath = null;
    }
  } else if (typeof text === 'string' && text.trim()) {
    if (text.length > MAX_PASTE_BYTES) {
      return { ok: false, error: 'Pasted text is larger than 1MB. Try splitting it up.' };
    }
    payload = text;
  } else {
    return { ok: false, error: 'Upload a file or paste your customer list.' };
  }

  // Truncation guard: Sonnet's context is plenty, but a 1MB CSV will
  // chew through tokens. The prompt asks the model to skip rows it can't
  // parse, so a partial pass is preferable to a timeout.
  const promptInput =
    payload.length > 200_000 ? `${payload.slice(0, 200_000)}\n[...truncated]` : payload;

  let raw: { customers: RawProposedCustomer[] };
  try {
    const res = await gateway().runStructured<{ customers: RawProposedCustomer[] }>({
      kind: 'structured',
      task: 'onboarding_customer_classify',
      tenant_id: tenant.id,
      prompt: `${CUSTOMER_PARSE_PROMPT}\n\nINPUT:\n${promptInput}`,
      schema: CUSTOMER_PARSE_SCHEMA,
      temperature: 0.1,
    });
    raw = res.data;
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
  }

  const proposals = (raw.customers ?? [])
    .map((r): ImportProposalRow['proposed'] | null => {
      const name = pickString(r.name);
      if (!name) return null;
      const type = r.type === 'residential' || r.type === 'commercial' ? r.type : null;
      return {
        name,
        email: pickString(r.email),
        phone: pickString(r.phone),
        addressLine1: pickString(r.address_line1),
        city: pickString(r.city),
        province: pickString(r.province),
        postalCode: pickString(r.postal_code),
        type,
        notes: pickString(r.notes),
      };
    })
    .filter((r): r is ImportProposalRow['proposed'] => r !== null);

  // Pull the tenant's existing customer roster once — dedup engine is O(n)
  // per proposal, the round-trip is the cost.
  const supabase = await createClient();
  const { data: existingRaw, error: existingErr } = await supabase
    .from('customers')
    .select('id, name, email, phone, city')
    .is('deleted_at', null);
  if (existingErr) return { ok: false, error: existingErr.message };
  const existing: ExistingCustomer[] = (existingRaw ?? []).map((c) => ({
    id: c.id as string,
    name: (c.name as string) ?? '',
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    city: (c.city as string | null) ?? null,
  }));

  const rows: ImportProposalRow[] = proposals.map((p, i) => {
    const m = findMatch(p, existing);
    return {
      rowKey: `r${i}`,
      proposed: p,
      match: {
        tier: m.tier,
        label: tierLabel(m.tier),
        existingId: m.existing?.id ?? null,
        existingName: m.existing?.name ?? null,
      },
    };
  });

  return {
    ok: true,
    sourceFilename,
    sourceStoragePath,
    rows,
    summary: {
      proposed: rows.length,
      matched: rows.filter((r) => r.match.tier !== null).length,
    },
  };
}

// ─── Commit: write the import_batch + customers ──────────────────────────────

export type CommitImportRow = {
  rowKey: string;
  /** What to do with this row. 'create' = new customer; 'merge' = treat
   *  as the existing customer (no insert); 'skip' = ignore entirely. */
  decision: 'create' | 'merge' | 'skip';
  /** When decision='merge', the existing customer to attribute to. */
  existingId?: string | null;
  /** Final, possibly-edited values from the operator. */
  proposed: ImportProposalRow['proposed'];
};

export type CommitImportResult =
  | {
      ok: true;
      batchId: string;
      created: number;
      merged: number;
      skipped: number;
    }
  | { ok: false; error: string };

export async function commitCustomerImportAction(input: {
  rows: CommitImportRow[];
  sourceFilename: string | null;
  sourceStoragePath: string | null;
  note: string | null;
}): Promise<CommitImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const merged = input.rows.filter((r) => r.decision === 'merge').length;
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;

  if (toCreate.length === 0 && merged === 0) {
    return { ok: false, error: 'Nothing to commit — every row is set to skip.' };
  }

  // Create the batch row first so we have an id to tag the customers with.
  const user = await getCurrentUser();
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'customers',
      source_filename: input.sourceFilename,
      source_storage_path: input.sourceStoragePath,
      summary: { created: toCreate.length, merged, skipped },
      note: input.note?.trim() || null,
      created_by: user?.id ?? null,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  if (toCreate.length > 0) {
    const insertRows = toCreate.map((r) => ({
      tenant_id: tenant.id,
      name: r.proposed.name,
      email: r.proposed.email ?? null,
      phone: r.proposed.phone ?? null,
      address_line1: r.proposed.addressLine1 ?? null,
      city: r.proposed.city ?? null,
      province: r.proposed.province ?? null,
      postal_code: r.proposed.postalCode ?? null,
      type: r.proposed.type ?? null,
      notes: r.proposed.notes ?? null,
      kind: 'customer',
      import_batch_id: batchId,
    }));
    const { error: insErr } = await supabase.from('customers').insert(insertRows);
    if (insErr) {
      // Best-effort cleanup — drop the batch row so we don't leave a
      // batch with summary saying "5 created" but zero linked customers.
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: insErr.message };
    }
  }

  return {
    ok: true,
    batchId,
    created: toCreate.length,
    merged,
    skipped,
  };
}

// ─── Rollback: delete the batch's customers ──────────────────────────────────

export async function rollbackCustomerImportAction(
  batchId: string,
): Promise<{ ok: true; deleted: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  // Confirm the batch belongs to this tenant + isn't already rolled back.
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, kind, rolled_back_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchErr || !batch) return { ok: false, error: 'Batch not found.' };
  if (batch.rolled_back_at) return { ok: false, error: 'Batch already rolled back.' };
  if (batch.kind !== 'customers') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches in Phase A — customers only.`,
    };
  }

  // Soft-delete each customer in the batch via the same column the rest of
  // the app uses; do NOT hard-delete because they may already be referenced
  // by projects/jobs/invoices. The batch row records the rollback for audit.
  const now = new Date().toISOString();
  const { data: deletedRows, error: delErr } = await supabase
    .from('customers')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (delErr) return { ok: false, error: delErr.message };

  const user = await getCurrentUser();
  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return { ok: true, deleted: (deletedRows ?? []).length };
}
