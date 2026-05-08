'use server';

/**
 * Phase F (last) of the onboarding-import wizard. Time entries.
 *
 * Text-shaped like A/B/C: operator pastes or uploads a sheet and the
 * model classifies rows. Two new wrinkles vs Phase B/C:
 *
 *   1. **Worker resolution is read-only.** Time entries' `user_id` MUST
 *      reference an existing tenant_member — we can't auto-create a
 *      worker (auth requires email confirmation, password setup, etc).
 *      Rows whose worker name doesn't match a member fall back to the
 *      importing user (the contractor entering their own historical
 *      hours), with a per-row override in the wizard.
 *
 *   2. **Hours format is messy.** Sources use "8h", "8:00", "0.125
 *      day", "8.5 hrs" — the prompt asks for hours as a decimal number
 *      and we accept whatever the model returns. If the model can't
 *      parse confidently, the row surfaces with hours=null and the
 *      operator fixes it before commit.
 *
 * Project resolution piggybacks on the customer-side dedup engine via
 * the projects/dedup helper, identical to Phase B's logic.
 *
 * Rollback hard-deletes (time_entries has no deleted_at). Same trade-
 * off as expenses (D).
 */

import { gateway, isAiError } from '@/lib/ai-gateway';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { type ExistingProject, findProjectMatch } from '@/lib/projects/dedup';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import {
  type ExistingMember,
  findWorkerMatch,
  type WorkerMatchTier,
  workerTierLabel,
} from '@/lib/time-entries/dedup';

const MAX_PASTE_BYTES = 25 * 1024 * 1024;
const MAX_LLM_SLICE_CHARS = 800_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type ProposedTimeEntry = {
  workerName: string | null;
  projectName: string | null;
  entryDateIso: string | null;
  hours: number | null;
  notes: string | null;
};

export type WorkerResolutionView =
  | {
      kind: 'matched';
      userId: string;
      label: string;
      tier: WorkerMatchTier;
    }
  | { kind: 'fallback_to_importer'; importerLabel: string }
  | { kind: 'unmatched'; rawName: string | null };

export type ProjectResolutionView =
  | { kind: 'matched'; existingId: string; existingName: string }
  | { kind: 'unattached' };

export type TimeEntryProposalRow = {
  rowKey: string;
  proposed: ProposedTimeEntry;
  worker: WorkerResolutionView;
  project: ProjectResolutionView;
};

export type ParseTimeEntryResult =
  | {
      ok: true;
      sourceFilename: string | null;
      sourceStoragePath: string | null;
      rows: TimeEntryProposalRow[];
      summary: {
        proposed: number;
        unmatchedWorkers: number;
        attachedToProjects: number;
      };
      /** Tenant member roster surfaced to the wizard for manual
       *  per-row reassignments. */
      members: { userId: string; label: string }[];
    }
  | { ok: false; error: string };

// ─── Parse ──────────────────────────────────────────────────────────────────

const TIME_ENTRY_PARSE_PROMPT = `You are reading a time / payroll log a Canadian renovation contractor wants to import. Each row is ONE entry: which worker, which project, which day, how many hours, optional notes.

Rules:
- "worker_name" — exactly as written in the source (e.g. "Sam Patel", "Sam", "S. Patel"). null if the source has no name column at all (in that case the row likely refers to the contractor themselves and the wizard handles it).
- "project_name" — the project / job the hours were against. null if the source genuinely has no project label, or the row is generic admin time.
- "entry_date" — YYYY-MM-DD. Look for "Date", "Day", "Worked". Skip rows that are header / total / subtotal lines.
- "hours" — DECIMAL number. Convert "8h" / "8 hrs" / "8.5" → 8 / 8 / 8.5. Convert "8:00" → 8.0, "8:30" → 8.5, "8:15" → 8.25. Convert "0.5 day" → 4 (assume 8-hour days). null only if you can't confidently parse the cell.
- "notes" — short single-line description of the work, drawn from any free-form column. null when absent.

Return ONLY JSON matching the schema. No prose, no markdown.`;

const TIME_ENTRY_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          worker_name: { type: ['string', 'null'] },
          project_name: { type: ['string', 'null'] },
          entry_date: { type: ['string', 'null'] },
          hours: { type: ['number', 'null'] },
          notes: { type: ['string', 'null'] },
        },
        required: ['entry_date'],
      },
    },
  },
  required: ['entries'],
};

type RawTimeEntry = {
  worker_name?: unknown;
  project_name?: unknown;
  entry_date?: unknown;
  hours?: unknown;
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

function pickNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  return null;
}

function pickDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.slice(0, 10) : null;
}

export async function parseTimeEntryImportAction(
  formData: FormData,
): Promise<ParseTimeEntryResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

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
      console.error('[onboarding-import-time-entries] source archive failed:', uploadErr.message);
      sourceStoragePath = null;
    }
  } else if (typeof text === 'string' && text.trim()) {
    if (text.length > MAX_PASTE_BYTES) {
      return { ok: false, error: 'Pasted text is larger than 25MB. Try splitting it up.' };
    }
    payload = text;
  } else {
    return { ok: false, error: 'Upload a file or paste your time entries.' };
  }

  const promptInput =
    payload.length > MAX_LLM_SLICE_CHARS
      ? `${payload.slice(0, MAX_LLM_SLICE_CHARS)}\n[...truncated — too large for one pass; split the file]`
      : payload;

  let raw: { entries: RawTimeEntry[] };
  try {
    const res = await gateway().runStructured<{ entries: RawTimeEntry[] }>({
      kind: 'structured',
      task: 'onboarding_time_entry_classify',
      tenant_id: tenant.id,
      prompt: `${TIME_ENTRY_PARSE_PROMPT}\n\nINPUT:\n${promptInput}`,
      schema: TIME_ENTRY_PARSE_SCHEMA,
      temperature: 0.1,
    });
    raw = res.data;
  } catch (err) {
    return { ok: false, error: userSafeError(err) };
  }

  const proposals: ProposedTimeEntry[] = (raw.entries ?? [])
    .map((r): ProposedTimeEntry | null => {
      const date = pickDate(r.entry_date);
      if (!date) return null;
      return {
        workerName: pickString(r.worker_name),
        projectName: pickString(r.project_name),
        entryDateIso: date,
        hours: pickNumber(r.hours),
        notes: pickString(r.notes),
      };
    })
    .filter((p): p is ProposedTimeEntry => p !== null);

  // Members + projects in parallel.
  const supabase = await createClient();
  const [{ data: memberRowsRaw, error: memErr }, { data: projectRowsRaw, error: projErr }] =
    await Promise.all([
      supabase.from('tenant_members').select('user_id, first_name, last_name'),
      supabase
        .from('projects')
        .select('id, name, customer_id, customers:customer_id (name)')
        .is('deleted_at', null),
    ]);
  if (memErr) return { ok: false, error: memErr.message };
  if (projErr) return { ok: false, error: projErr.message };

  const members: ExistingMember[] = (memberRowsRaw ?? []).map((m) => ({
    user_id: m.user_id as string,
    first_name: (m.first_name as string | null) ?? null,
    last_name: (m.last_name as string | null) ?? null,
  }));
  const projects: ExistingProject[] = (projectRowsRaw ?? []).map((p) => {
    const cust = (p as Record<string, unknown>).customers as { name?: string } | null;
    return {
      id: p.id as string,
      name: (p.name as string) ?? '',
      customer_id: (p.customer_id as string | null) ?? null,
      customer_name: cust?.name ?? null,
    };
  });

  const importerLabel =
    members.find((m) => m.user_id === user.id) !== undefined
      ? prettyMember(members.find((m) => m.user_id === user.id)!)
      : (user.email ?? 'me');

  const rows: TimeEntryProposalRow[] = proposals.map((p, i) => {
    const wm = findWorkerMatch(p.workerName, members);
    const worker: WorkerResolutionView =
      wm.tier && wm.userId
        ? { kind: 'matched', userId: wm.userId, label: wm.label ?? wm.userId, tier: wm.tier }
        : !p.workerName
          ? { kind: 'fallback_to_importer', importerLabel }
          : { kind: 'unmatched', rawName: p.workerName };

    const proj = p.projectName
      ? findProjectMatch({ name: p.projectName }, projects)
      : { tier: null, existing: null };
    const project: ProjectResolutionView = proj.existing
      ? { kind: 'matched', existingId: proj.existing.id, existingName: proj.existing.name }
      : { kind: 'unattached' };

    return {
      rowKey: `t${i}`,
      proposed: p,
      worker,
      project,
    };
  });

  // Surface every active tenant member to the wizard so the operator
  // can manually re-assign rows whose worker name didn't match.
  const memberOptions = members.map((m) => ({
    userId: m.user_id,
    label: prettyMember(m),
  }));

  return {
    ok: true,
    sourceFilename,
    sourceStoragePath,
    rows,
    summary: {
      proposed: rows.length,
      unmatchedWorkers: rows.filter((r) => r.worker.kind === 'unmatched').length,
      attachedToProjects: rows.filter((r) => r.project.kind === 'matched').length,
    },
    members: memberOptions,
  };
}

function prettyMember(m: ExistingMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ') || '(unnamed member)';
}

// ─── Commit ─────────────────────────────────────────────────────────────────

export type CommitTimeEntryRow = {
  rowKey: string;
  decision: 'create' | 'skip';
  /** Final operator-resolved user_id for this row. May be the importer
   *  fallback, a matched member, or one the operator manually picked. */
  userId: string;
  proposed: ProposedTimeEntry;
  /** Operator's project pick (matched id) or null for unattached. */
  projectId: string | null;
};

export type CommitTimeEntryResult =
  | { ok: true; batchId: string; created: number; skipped: number }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export async function commitTimeEntryImportAction(input: {
  rows: CommitTimeEntryRow[];
  sourceFilename: string | null;
  sourceStoragePath: string | null;
  note: string | null;
}): Promise<CommitTimeEntryResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;

  const insufficient = toCreate.filter(
    (r) => r.proposed.hours === null || r.proposed.hours <= 0 || !r.proposed.entryDateIso,
  );
  if (insufficient.length > 0) {
    return {
      ok: false,
      error: `${insufficient.length} row${insufficient.length === 1 ? ' is' : 's are'} missing hours or date. Fill them in or skip those rows.`,
    };
  }
  if (toCreate.length === 0) {
    return { ok: false, error: 'Nothing to commit — every row is set to skip.' };
  }

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'time_entries',
      source_filename: input.sourceFilename,
      source_storage_path: input.sourceStoragePath,
      summary: { created: toCreate.length, merged: 0, skipped },
      note: input.note?.trim() || null,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  const entryRows = toCreate.map((r) => ({
    tenant_id: tenant.id,
    user_id: r.userId,
    project_id: r.projectId,
    hours: r.proposed.hours ?? 0,
    notes: r.proposed.notes,
    entry_date: r.proposed.entryDateIso,
    import_batch_id: batchId,
  }));

  const { error: insErr } = await supabase.from('time_entries').insert(entryRows);
  if (insErr) {
    await supabase.from('import_batches').delete().eq('id', batchId);
    return { ok: false, error: insErr.message };
  }

  return {
    ok: true,
    batchId,
    created: toCreate.length,
    skipped,
  };
}

// ─── Rollback ───────────────────────────────────────────────────────────────

export async function rollbackTimeEntryImportAction(
  batchId: string,
): Promise<{ ok: true; deletedEntries: number } | { ok: false; error: string }> {
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
  if (batch.kind !== 'time_entries') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches with the time-entries rollback action.`,
    };
  }

  // Hard-delete (time_entries has no deleted_at column).
  const { data: deletedRows, error: delErr } = await supabase
    .from('time_entries')
    .delete()
    .eq('import_batch_id', batchId)
    .select('id');
  if (delErr) return { ok: false, error: delErr.message };

  const now = new Date().toISOString();
  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return { ok: true, deletedEntries: (deletedRows ?? []).length };
}

export { workerTierLabel };
