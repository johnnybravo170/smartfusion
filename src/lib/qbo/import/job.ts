/**
 * `qbo_import_jobs` state helpers.
 *
 * One row tracks the lifecycle of a single QBO backfill: configuration
 * (date range, requested entities), progress (per-entity counters), API
 * call count, batch_ids per entity, and a review queue of ambiguous
 * customer matches awaiting user resolution.
 *
 * All writes use the service-role admin client so the worker can update
 * progress regardless of the calling session's role.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type QboImportEntity =
  | 'Customer'
  | 'Vendor'
  | 'Item'
  | 'Invoice'
  | 'Payment'
  | 'Estimate'
  | 'Bill'
  | 'Purchase';

export type EntityCounters = {
  fetched: number;
  imported: number;
  skipped: number;
  failed: number;
};

export type ReviewQueueEntry = {
  /** QBO entity Id awaiting resolution. */
  qbo_id: string;
  /** Entity kind — extension point for future review surfaces. */
  entity_type: 'customer';
  /** What the user sees when picking. */
  qbo_name: string;
  qbo_email: string | null;
  qbo_phone: string | null;
  /** HH candidates the dedup helper turned up. */
  candidates: Array<{
    hh_id: string;
    name: string;
    email: string | null;
    phone: string | null;
    tier: 'name+city' | 'name';
  }>;
};

export type ImportJobRow = {
  id: string;
  tenant_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  requested_entities: string[];
  date_range_from: string | null;
  date_range_to: string | null;
  entity_counters: Partial<Record<QboImportEntity, EntityCounters>>;
  api_calls_used: number;
  batch_ids: Partial<Record<string, string>>;
  review_queue: ReviewQueueEntry[];
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateImportJobInput = {
  tenantId: string;
  requestedEntities: QboImportEntity[];
  dateRangeFrom?: string | null;
  dateRangeTo?: string | null;
  createdBy?: string | null;
};

export async function createImportJob(input: CreateImportJobInput): Promise<ImportJobRow> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('qbo_import_jobs')
    .insert({
      tenant_id: input.tenantId,
      status: 'queued',
      requested_entities: input.requestedEntities,
      date_range_from: input.dateRangeFrom ?? null,
      date_range_to: input.dateRangeTo ?? null,
      entity_counters: {},
      api_calls_used: 0,
      batch_ids: {},
      review_queue: [],
      created_by: input.createdBy ?? null,
    })
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(`Failed to create import job: ${error?.message ?? 'unknown'}`);
  }
  return data as ImportJobRow;
}

export async function loadImportJob(jobId: string): Promise<ImportJobRow | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('qbo_import_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load import job: ${error.message}`);
  }
  return (data as ImportJobRow | null) ?? null;
}

export async function markJobRunning(jobId: string): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('qbo_import_jobs')
    .update({ status: 'running', started_at: now, updated_at: now })
    .eq('id', jobId);
  if (error) throw new Error(`Failed to mark job running: ${error.message}`);
}

export async function markJobCompleted(jobId: string): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('qbo_import_jobs')
    .update({ status: 'completed', finished_at: now, updated_at: now })
    .eq('id', jobId);
  if (error) throw new Error(`Failed to mark job completed: ${error.message}`);
}

export async function markJobFailed(jobId: string, errorMessage: string): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('qbo_import_jobs')
    .update({
      status: 'failed',
      error_message: errorMessage.slice(0, 4000),
      finished_at: now,
      updated_at: now,
    })
    .eq('id', jobId);
  if (error) throw new Error(`Failed to mark job failed: ${error.message}`);
}

/**
 * Add `delta` to a specific entity's counters and bump api_calls_used.
 * Reads the current JSONB, merges, writes back. Single round-trip per
 * batch (1000 rows) keeps this cheap.
 */
export async function bumpJobProgress(
  jobId: string,
  entity: QboImportEntity,
  delta: Partial<EntityCounters>,
  apiCallsDelta = 0,
): Promise<void> {
  const supabase = createAdminClient();
  const { data, error: loadErr } = await supabase
    .from('qbo_import_jobs')
    .select('entity_counters, api_calls_used')
    .eq('id', jobId)
    .single();
  if (loadErr || !data) {
    throw new Error(`Failed to load job for progress bump: ${loadErr?.message ?? 'unknown'}`);
  }

  const counters = (data.entity_counters ?? {}) as Partial<Record<QboImportEntity, EntityCounters>>;
  const current = counters[entity] ?? { fetched: 0, imported: 0, skipped: 0, failed: 0 };
  const merged: EntityCounters = {
    fetched: current.fetched + (delta.fetched ?? 0),
    imported: current.imported + (delta.imported ?? 0),
    skipped: current.skipped + (delta.skipped ?? 0),
    failed: current.failed + (delta.failed ?? 0),
  };
  counters[entity] = merged;

  const { error: updErr } = await supabase
    .from('qbo_import_jobs')
    .update({
      entity_counters: counters,
      api_calls_used: (data.api_calls_used as number) + apiCallsDelta,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (updErr) {
    throw new Error(`Failed to bump job progress: ${updErr.message}`);
  }
}

/**
 * Attach an `import_batches` row id for a given entity kind. Called once
 * per kind at the start of that kind's import so rollback can target a
 * subset of the job.
 */
export async function setBatchIdForEntity(
  jobId: string,
  entityKind: string,
  batchId: string,
): Promise<void> {
  const supabase = createAdminClient();
  const { data, error: loadErr } = await supabase
    .from('qbo_import_jobs')
    .select('batch_ids')
    .eq('id', jobId)
    .single();
  if (loadErr || !data) {
    throw new Error(`Failed to load batch_ids: ${loadErr?.message ?? 'unknown'}`);
  }
  const batchIds = (data.batch_ids ?? {}) as Record<string, string>;
  batchIds[entityKind] = batchId;
  const { error: updErr } = await supabase
    .from('qbo_import_jobs')
    .update({ batch_ids: batchIds, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (updErr) throw new Error(`Failed to attach batch_id: ${updErr.message}`);
}

/**
 * Append entries to the review_queue. Idempotent on (entity_type, qbo_id):
 * re-running the import won't duplicate review-queue entries.
 */
export async function appendReviewQueue(jobId: string, entries: ReviewQueueEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const supabase = createAdminClient();
  const { data, error: loadErr } = await supabase
    .from('qbo_import_jobs')
    .select('review_queue')
    .eq('id', jobId)
    .single();
  if (loadErr || !data) {
    throw new Error(`Failed to load review_queue: ${loadErr?.message ?? 'unknown'}`);
  }
  const existing = (data.review_queue ?? []) as ReviewQueueEntry[];
  const seen = new Set(existing.map((r) => `${r.entity_type}:${r.qbo_id}`));
  const merged = [...existing];
  for (const e of entries) {
    const key = `${e.entity_type}:${e.qbo_id}`;
    if (!seen.has(key)) {
      merged.push(e);
      seen.add(key);
    }
  }
  const { error: updErr } = await supabase
    .from('qbo_import_jobs')
    .update({ review_queue: merged, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (updErr) throw new Error(`Failed to append to review_queue: ${updErr.message}`);
}
