'use server';

/**
 * Rollback for QBO import jobs.
 *
 * Every entity kind in a QBO import gets its own `import_batches` row,
 * referenced from `qbo_import_jobs.batch_ids` (JSONB map). Rolling
 * back a job means:
 *   1. For each entity kind in batch_ids, delete every row tagged
 *      with that batch_id from the entity's table.
 *   2. Mark the import_batches row as rolled_back_at.
 *
 * Cascade FKs handle dependent rows:
 *   - bills → bill_line_items (CASCADE)
 *   - invoices → quote_surfaces / quote_line_items (only set when
 *     quote_surfaces.line_item_id refers to it — invoice rollback
 *     doesn't touch quotes by design)
 *
 * Order matters: delete children before parents so RESTRICT FKs
 * don't fail. The order below mirrors the import order in reverse:
 *   purchases (expenses) → bills → payments → estimates → invoices
 *   → items → vendors → customers
 *
 * Each batch deletion runs in its own statement; if any fails, the
 * job is left in a partially-rolled-back state but every successfully
 * rolled-back batch is marked. The user can re-run rollback to finish.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { loadImportJob } from '@/lib/qbo/import/job';
import { createAdminClient } from '@/lib/supabase/admin';

export type ImportHistoryEntry = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  finished_at: string | null;
  entity_counters: Record<
    string,
    { fetched: number; imported: number; skipped: number; failed: number }
  >;
  api_calls_used: number;
  /** Map of entity kind → import_batches row id; from qbo_import_jobs.batch_ids */
  batch_ids: Record<string, string>;
  /** Aggregate: how many of those batches are still un-rolled-back? */
  active_batch_count: number;
  /** Total rows currently still tagged with this job's batches (cheap roll-up). */
  rolled_back: boolean;
};

export type ListImportHistoryResult =
  | { ok: true; jobs: ImportHistoryEntry[] }
  | { ok: false; error: string };

/**
 * Fetch the last 20 import jobs + their batch rollback state for the
 * current tenant. Used by the history/rollback page.
 */
export async function listImportHistoryAction(): Promise<ListImportHistoryResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = createAdminClient();
  const { data: jobs, error } = await supabase
    .from('qbo_import_jobs')
    .select('id, status, created_at, finished_at, entity_counters, api_calls_used, batch_ids')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return { ok: false, error: `Failed to load import jobs: ${error.message}` };
  }

  // Roll up batch states. One query against import_batches covers all
  // the batches referenced by these jobs, then we fan back out.
  const allBatchIds = new Set<string>();
  for (const job of jobs ?? []) {
    const ids = Object.values((job.batch_ids as Record<string, string>) ?? {});
    for (const id of ids) if (id) allBatchIds.add(id);
  }
  let batchState = new Map<string, { rolled_back_at: string | null }>();
  if (allBatchIds.size > 0) {
    const { data: batches, error: batchErr } = await supabase
      .from('import_batches')
      .select('id, rolled_back_at')
      .in('id', Array.from(allBatchIds));
    if (batchErr) {
      return { ok: false, error: `Failed to load import batches: ${batchErr.message}` };
    }
    batchState = new Map(
      (batches ?? []).map((b) => [
        b.id as string,
        { rolled_back_at: (b.rolled_back_at as string | null) ?? null },
      ]),
    );
  }

  const out: ImportHistoryEntry[] = [];
  for (const row of jobs ?? []) {
    const r = row as {
      id: string;
      status: ImportHistoryEntry['status'];
      created_at: string;
      finished_at: string | null;
      entity_counters: ImportHistoryEntry['entity_counters'];
      api_calls_used: number;
      batch_ids: Record<string, string>;
    };
    const batchIds = Object.values(r.batch_ids ?? {});
    const stillActive = batchIds.filter(
      (id) => id && batchState.get(id)?.rolled_back_at == null,
    ).length;
    out.push({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      finished_at: r.finished_at,
      entity_counters: r.entity_counters ?? {},
      api_calls_used: r.api_calls_used,
      batch_ids: r.batch_ids ?? {},
      active_batch_count: stillActive,
      rolled_back: batchIds.length > 0 && stillActive === 0,
    });
  }
  return { ok: true, jobs: out };
}

const rollbackSchema = z.object({ jobId: z.string().uuid() });
export type RollbackJobInput = z.input<typeof rollbackSchema>;
export type RollbackJobResult =
  | { ok: true; deleted: Record<string, number> }
  | { ok: false; error: string };

/**
 * Delete order is the inverse of import order. Each kind maps to the
 * table where the rows live. A null table value means "rows are
 * tagged but the import_batches.kind doesn't correspond to a real
 * table"; current epic doesn't hit that branch.
 */
const ROLLBACK_ORDER: Array<{ kind: string; table: string }> = [
  { kind: 'expenses', table: 'expenses' },
  { kind: 'bills', table: 'bills' },
  { kind: 'payments', table: 'payments' },
  { kind: 'quotes', table: 'quotes' },
  { kind: 'invoices', table: 'invoices' },
  { kind: 'items', table: 'catalog_items' },
  { kind: 'vendors', table: 'customers' },
  { kind: 'customers', table: 'customers' },
];

export async function rollbackImportJobAction(input: RollbackJobInput): Promise<RollbackJobResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = rollbackSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const job = await loadImportJob(parsed.data.jobId);
  if (!job) return { ok: false, error: 'Import job not found.' };
  if (job.tenant_id !== tenant.id) {
    return { ok: false, error: 'Import job belongs to a different account.' };
  }

  const supabase = createAdminClient();
  const deleted: Record<string, number> = {};

  for (const { kind, table } of ROLLBACK_ORDER) {
    const batchId = (job.batch_ids as Record<string, string>)[kind];
    if (!batchId) continue;

    // Skip already-rolled-back batches so re-running rollback after a
    // partial failure picks up where it left off.
    const { data: batchRow } = await supabase
      .from('import_batches')
      .select('rolled_back_at')
      .eq('id', batchId)
      .maybeSingle();
    if (batchRow && (batchRow as { rolled_back_at: string | null }).rolled_back_at) {
      continue;
    }

    // Delete the rows in this batch from their entity table. RLS is
    // bypassed by the admin client; we already verified tenant
    // ownership of the job above.
    const { count, error: delErr } = await supabase
      .from(table)
      .delete({ count: 'exact' })
      .eq('tenant_id', tenant.id)
      .eq('import_batch_id', batchId);
    if (delErr) {
      return { ok: false, error: `Failed to delete ${kind}: ${delErr.message}` };
    }
    deleted[kind] = count ?? 0;

    // Mark the batch as rolled back so listImportHistoryAction reflects
    // it on next page load.
    await supabase
      .from('import_batches')
      .update({ rolled_back_at: new Date().toISOString() })
      .eq('id', batchId);
  }

  revalidatePath('/settings/qbo-history');
  revalidatePath('/settings');
  return { ok: true, deleted };
}
