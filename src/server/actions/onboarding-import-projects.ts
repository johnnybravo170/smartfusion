'use server';

/**
 * Phase B of the onboarding import wizard. Projects + estimate
 * scaffolding (no money math — that's Phase C with invoices).
 *
 * The hard part vs Phase A is cross-entity FK resolution: each
 * proposed project carries a customer reference that needs to land
 * on a real customer row. Three cases:
 *
 *   1. Operator's roster already has them → resolve to the existing
 *      customer.id. Most common when the customer-import phase has
 *      already run.
 *   2. Operator's roster doesn't have them yet → wizard offers to
 *      "Create with the project import." When the operator confirms,
 *      commit creates the customer first (tagged with the SAME
 *      projects-kind batch_id so rollback removes both) and uses the
 *      new id as the project's FK.
 *   3. Operator wants to skip / re-map → per-row override on the
 *      preview (existing customer picker or "leave unattached").
 *
 * The customers created as side-effects of a projects import keep
 * the projects-kind batch_id on their import_batch_id. That makes
 * rollback semantics trivial: delete everything tagged with this
 * batch and the operator gets back to clean state in one click.
 *
 * See:
 *   - migration 0186_projects_import_batch.sql
 *   - src/lib/projects/dedup.ts
 *   - PATTERNS.md §16
 */

import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import {
  type ExistingCustomer,
  findMatch as findCustomerMatch,
  normalizeName,
} from '@/lib/customers/dedup';
import {
  type ExistingProject,
  findProjectMatch,
  type ProjectMatchTier,
  projectTierLabel,
} from '@/lib/projects/dedup';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

// See onboarding-import.ts for cap rationale; same numbers apply.
const MAX_PASTE_BYTES = 25 * 1024 * 1024; // 25MB
const MAX_LLM_SLICE_CHARS = 800_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProposedProject = {
  name: string;
  description?: string | null;
  customerName?: string | null;
  /** Optional ballpark dollar value the operator typed in the source.
   *  Captured for context only — Phase B doesn't write money math.
   *  Surfaces in the preview as a faded hint and (Phase C) becomes the
   *  estimate seed. */
  ballparkAmountText?: string | null;
  /** Optional lifecycle hint from the source: planning / active /
   *  complete / awaiting_approval. Stays nullable; the wizard defaults
   *  to 'planning' if the operator doesn't override. */
  lifecycleStage?: 'planning' | 'awaiting_approval' | 'active' | 'complete' | null;
  notes?: string | null;
};

export type CustomerResolution =
  | {
      kind: 'matched';
      existingId: string;
      existingName: string;
      tier: 'email' | 'phone' | 'name+city' | 'name';
    }
  | {
      kind: 'create';
      /** Will create a new customer with this name. Other customer
       *  fields default to null — the operator can edit later via the
       *  contact page. */
      newName: string;
    }
  | { kind: 'unattached' };

export type ProjectImportProposalRow = {
  rowKey: string;
  proposed: ProposedProject;
  customer: CustomerResolution;
  /** Match against existing projects (so we don't double-import the
   *  same project on a re-run). */
  projectMatch: {
    tier: ProjectMatchTier;
    label: string;
    existingId: string | null;
    existingName: string | null;
  };
};

export type ParseProjectImportResult =
  | {
      ok: true;
      sourceFilename: string | null;
      sourceStoragePath: string | null;
      rows: ProjectImportProposalRow[];
      summary: {
        proposed: number;
        customersToCreate: number;
        projectMatches: number;
      };
    }
  | { ok: false; error: string };

// ─── Parse: file/paste → proposed projects ──────────────────────────────────

const PROJECT_PARSE_PROMPT = `You are reading a list of projects/quotes a Canadian renovation contractor wants to import. The input may be a Google Sheets export, an Excel-as-CSV, plain text, or a copy-paste from anywhere. Each row is ONE project.

Rules:
- "name" is required. The project name should NOT include the customer's name unless that's the only label the contractor uses (e.g. "Smith Bathroom" is fine if the source row literally said that).
- "customer_name" is the customer/client this project is for, exactly as written in the source. If the source separates them, return the customer name only (no address/phone). null if you genuinely can't tell.
- "description" — short, one or two lines, drawn from any free-form description column. null if not present. DO NOT pad.
- "ballpark_amount_text" — if the source has a dollar figure, return it as written ("$45,000", "45k", etc.) so the operator can verify. We're not parsing it into a number in this phase. null if absent.
- "lifecycle_stage" — only set if the source explicitly indicates status:
    "planning" / "draft" / "quote" → "planning"
    "sent" / "awaiting" / "pending approval" → "awaiting_approval"
    "active" / "in progress" / "ongoing" / "scheduled" → "active"
    "done" / "complete" / "closed" / "won" → "complete"
  null otherwise.
- "notes" — anything interesting that didn't fit the structured fields. Keep short. null when nothing extra.
- If a row is clearly a section header / total / blank, skip it.

Return ONLY JSON matching the schema. No prose, no markdown.`;

const PROJECT_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    projects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: ['string', 'null'] },
          customer_name: { type: ['string', 'null'] },
          ballpark_amount_text: { type: ['string', 'null'] },
          lifecycle_stage: {
            type: ['string', 'null'],
            enum: ['planning', 'awaiting_approval', 'active', 'complete', null],
          },
          notes: { type: ['string', 'null'] },
        },
        required: ['name'],
      },
    },
  },
  required: ['projects'],
};

type RawProposedProject = {
  name: unknown;
  description?: unknown;
  customer_name?: unknown;
  ballpark_amount_text?: unknown;
  lifecycle_stage?: unknown;
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

function pickStage(v: unknown): ProposedProject['lifecycleStage'] {
  if (v === 'planning' || v === 'awaiting_approval' || v === 'active' || v === 'complete') {
    return v;
  }
  return null;
}

export async function parseProjectImportAction(
  formData: FormData,
): Promise<ParseProjectImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const file = formData.get('file');
  const text = formData.get('text');

  let payload: string;
  let sourceFilename: string | null = null;
  let sourceStoragePath: string | null = null;

  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_PASTE_BYTES) {
      return { ok: false, error: 'File is larger than 25MB. Try splitting it up.' };
    }
    sourceFilename = file.name;
    const buf = Buffer.from(await file.arrayBuffer());
    payload = buf.toString('utf8');

    const admin = createAdminClient();
    const stamp = Date.now();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_');
    sourceStoragePath = `${tenant.id}/${stamp}-${safeName}`;
    const { error: uploadErr } = await admin.storage
      .from('imports')
      .upload(sourceStoragePath, buf, { contentType: file.type || 'text/plain' });
    if (uploadErr) {
      console.error('[onboarding-import-projects] source archive failed:', uploadErr.message);
      sourceStoragePath = null;
    }
  } else if (typeof text === 'string' && text.trim()) {
    if (text.length > MAX_PASTE_BYTES) {
      return { ok: false, error: 'Pasted text is larger than 25MB. Try splitting it up.' };
    }
    payload = text;
  } else {
    return { ok: false, error: 'Upload a file or paste your project list.' };
  }

  const promptInput =
    payload.length > MAX_LLM_SLICE_CHARS
      ? `${payload.slice(0, MAX_LLM_SLICE_CHARS)}\n[...truncated — too large for one pass; split the file]`
      : payload;

  let raw: { projects: RawProposedProject[] };
  try {
    const res = await gateway().runStructured<{ projects: RawProposedProject[] }>({
      kind: 'structured',
      task: 'onboarding_project_classify',
      tenant_id: tenant.id,
      prompt: `${PROJECT_PARSE_PROMPT}\n\nINPUT:\n${promptInput}`,
      schema: PROJECT_PARSE_SCHEMA,
      temperature: 0.1,
    });
    raw = res.data;
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
  }

  const proposals: ProposedProject[] = (raw.projects ?? [])
    .map((r): ProposedProject | null => {
      const name = pickString(r.name);
      if (!name) return null;
      return {
        name,
        description: pickString(r.description),
        customerName: pickString(r.customer_name),
        ballparkAmountText: pickString(r.ballpark_amount_text),
        lifecycleStage: pickStage(r.lifecycle_stage),
        notes: pickString(r.notes),
      };
    })
    .filter((p): p is ProposedProject => p !== null);

  // Pull existing customers (for FK resolution) and existing projects
  // (for project-level dedup) in parallel.
  const supabase = await createClient();
  const [{ data: existingCustRaw, error: custErr }, { data: existingProjRaw, error: projErr }] =
    await Promise.all([
      supabase.from('customers').select('id, name, email, phone, city').is('deleted_at', null),
      supabase
        .from('projects')
        .select('id, name, customer_id, customers:customer_id (name)')
        .is('deleted_at', null),
    ]);
  if (custErr) return { ok: false, error: custErr.message };
  if (projErr) return { ok: false, error: projErr.message };

  const existingCustomers: ExistingCustomer[] = (existingCustRaw ?? []).map((c) => ({
    id: c.id as string,
    name: (c.name as string) ?? '',
    email: (c.email as string | null) ?? null,
    phone: (c.phone as string | null) ?? null,
    city: (c.city as string | null) ?? null,
  }));
  const existingProjects: ExistingProject[] = (existingProjRaw ?? []).map((p) => {
    const cust = (p as Record<string, unknown>).customers as { name?: string } | null;
    return {
      id: p.id as string,
      name: (p.name as string) ?? '',
      customer_id: (p.customer_id as string | null) ?? null,
      customer_name: cust?.name ?? null,
    };
  });

  // Resolve each row's customer + project match.
  const rows: ProjectImportProposalRow[] = proposals.map((p, i) => {
    const customer = resolveCustomer(p.customerName, existingCustomers);
    const projMatch = findProjectMatch(
      {
        name: p.name,
        customerName: p.customerName,
        customerId: customer.kind === 'matched' ? customer.existingId : null,
      },
      existingProjects,
    );
    return {
      rowKey: `p${i}`,
      proposed: p,
      customer,
      projectMatch: {
        tier: projMatch.tier,
        label: projectTierLabel(projMatch.tier),
        existingId: projMatch.existing?.id ?? null,
        existingName: projMatch.existing?.name ?? null,
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
      customersToCreate: rows.filter((r) => r.customer.kind === 'create').length,
      projectMatches: rows.filter((r) => r.projectMatch.tier !== null).length,
    },
  };
}

/** Decide what to do with the customer reference on a row. */
function resolveCustomer(
  customerName: string | null | undefined,
  existing: ExistingCustomer[],
): CustomerResolution {
  if (!customerName) return { kind: 'unattached' };
  const m = findCustomerMatch({ name: customerName }, existing);
  if (m.tier && m.existing) {
    // Only treat name-tier matches as "matched" if the operator has
    // limited input — we don't have email/phone in a project sheet so
    // name match is the strongest signal we'll get. Surface the tier
    // so the UI can color-code confidence.
    return {
      kind: 'matched',
      existingId: m.existing.id,
      existingName: m.existing.name,
      tier: m.tier,
    };
  }
  // Default: create a new customer with the name as written. Operator
  // can flip per row to 'unattached' if the row shouldn't carry a
  // customer.
  return { kind: 'create', newName: customerName };
}

// ─── Commit: write the batch + customers (side-effect) + projects ───────────

export type CommitProjectImportRow = {
  rowKey: string;
  decision: 'create' | 'merge' | 'skip';
  /** When decision='merge', the existing project we're merging into.
   *  No-op for now (Phase B doesn't update existing projects); will
   *  matter once Phase C imports invoices that reference projects. */
  existingProjectId?: string | null;
  proposed: ProposedProject;
  customer: CustomerResolution;
};

export type CommitProjectImportResult =
  | {
      ok: true;
      batchId: string;
      created: number;
      merged: number;
      skipped: number;
      customersCreated: number;
    }
  | { ok: false; error: string };

export async function commitProjectImportAction(input: {
  rows: CommitProjectImportRow[];
  sourceFilename: string | null;
  sourceStoragePath: string | null;
  note: string | null;
}): Promise<CommitProjectImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const merged = input.rows.filter((r) => r.decision === 'merge').length;
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;

  if (toCreate.length === 0 && merged === 0) {
    return { ok: false, error: 'Nothing to commit — every row is set to skip.' };
  }

  // Step 1: open the batch.
  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'projects',
      source_filename: input.sourceFilename,
      source_storage_path: input.sourceStoragePath,
      summary: {}, // populate after we know final counts
      note: input.note?.trim() || null,
      created_by: user?.id ?? null,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  // Step 2: create all the new customers up front, dedup'ing within the
  // import itself (the same customer may be referenced by 5 project
  // rows — we only want ONE new customer row, used by all 5).
  const customerNameToId = new Map<string, string>();
  // Pre-populate with existing matches so the lookup at project-insert
  // time is uniform.
  for (const r of toCreate) {
    if (r.customer.kind === 'matched') {
      customerNameToId.set(normalizeName(r.customer.existingName), r.customer.existingId);
    }
  }

  const newCustomerNames = Array.from(
    new Set(
      toCreate
        .filter((r) => r.customer.kind === 'create')
        .map((r) => (r.customer.kind === 'create' ? r.customer.newName.trim() : ''))
        .filter(Boolean),
    ),
  );
  let customersCreated = 0;
  if (newCustomerNames.length > 0) {
    const newCustomerRows = newCustomerNames.map((name) => ({
      tenant_id: tenant.id,
      name,
      kind: 'customer',
      import_batch_id: batchId,
    }));
    const { data: insertedCustomers, error: custInsErr } = await supabase
      .from('customers')
      .insert(newCustomerRows)
      .select('id, name');
    if (custInsErr) {
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: custInsErr.message };
    }
    for (const c of insertedCustomers ?? []) {
      customerNameToId.set(normalizeName(c.name as string), c.id as string);
    }
    customersCreated = (insertedCustomers ?? []).length;
  }

  // Step 3: insert projects with resolved customer FKs.
  const projectRows = toCreate.map((r) => {
    let customerId: string | null = null;
    if (r.customer.kind === 'matched') customerId = r.customer.existingId;
    else if (r.customer.kind === 'create') {
      customerId = customerNameToId.get(normalizeName(r.customer.newName)) ?? null;
    }
    return {
      tenant_id: tenant.id,
      customer_id: customerId,
      name: r.proposed.name,
      description: r.proposed.description ?? null,
      lifecycle_stage: r.proposed.lifecycleStage ?? 'planning',
      import_batch_id: batchId,
    };
  });

  if (projectRows.length > 0) {
    const { error: projInsErr } = await supabase.from('projects').insert(projectRows);
    if (projInsErr) {
      // Roll back the batch + side-effect customers we just created.
      await supabase.from('customers').delete().eq('import_batch_id', batchId);
      await supabase.from('import_batches').delete().eq('id', batchId);
      return { ok: false, error: projInsErr.message };
    }
  }

  // Step 4: backfill summary now that we know the real counts.
  const finalSummary = {
    created: toCreate.length,
    merged,
    skipped,
    customersCreated,
  };
  await supabase.from('import_batches').update({ summary: finalSummary }).eq('id', batchId);

  return {
    ok: true,
    batchId,
    created: toCreate.length,
    merged,
    skipped,
    customersCreated,
  };
}

// ─── Rollback: soft-delete projects + side-effect customers ─────────────────

export async function rollbackProjectImportAction(
  batchId: string,
): Promise<
  { ok: true; deletedProjects: number; deletedCustomers: number } | { ok: false; error: string }
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, kind, rolled_back_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchErr || !batch) return { ok: false, error: 'Batch not found.' };
  if (batch.rolled_back_at) return { ok: false, error: 'Batch already rolled back.' };
  if (batch.kind !== 'projects') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches with the project rollback action.`,
    };
  }

  const now = new Date().toISOString();

  // Soft-delete projects first (operator-visible).
  const { data: deletedProjRows, error: projDelErr } = await supabase
    .from('projects')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (projDelErr) return { ok: false, error: projDelErr.message };

  // Then soft-delete the side-effect customers tagged with this batch.
  // Only the customers WE created during this import — operator's pre-
  // existing customers were never tagged.
  const { data: deletedCustRows, error: custDelErr } = await supabase
    .from('customers')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (custDelErr) return { ok: false, error: custDelErr.message };

  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return {
    ok: true,
    deletedProjects: (deletedProjRows ?? []).length,
    deletedCustomers: (deletedCustRows ?? []).length,
  };
}
