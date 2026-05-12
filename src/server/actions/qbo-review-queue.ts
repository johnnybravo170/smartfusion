'use server';

/**
 * Server actions for resolving the QBO customer review queue.
 *
 * The import worker queues ambiguous customer matches into
 * `qbo_import_jobs.review_queue` (JSONB). This module surfaces those
 * entries and applies one of three resolutions per entry:
 *
 *   - 'merge'  — bind the QBO customer id to an existing HH customer
 *   - 'create' — insert a fresh customer from the QBO data on file
 *   - 'skip'   — drop from the queue, do nothing
 *
 * Each resolution removes the entry from the JSONB queue atomically.
 * After resolving, the user can re-run the import and any
 * previously-skipped invoices / estimates / payments / bills tied to
 * the now-resolved customer will land cleanly.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { loadImportJob, type ReviewQueueEntry } from '@/lib/qbo/import/job';
import { createAdminClient } from '@/lib/supabase/admin';

export type ReviewJobSummary = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  created_at: string;
  finished_at: string | null;
  queue: ReviewQueueEntry[];
};

export type ListReviewQueueResult =
  | { ok: true; jobs: ReviewJobSummary[] }
  | { ok: false; error: string };

/**
 * Fetch every import job for the current tenant that has a non-empty
 * review queue. Newest first. Used by the resolution page.
 */
export async function listReviewQueueAction(): Promise<ListReviewQueueResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('qbo_import_jobs')
    .select('id, status, created_at, finished_at, review_queue')
    .eq('tenant_id', tenant.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    return { ok: false, error: `Failed to load import jobs: ${error.message}` };
  }

  const jobs: ReviewJobSummary[] = [];
  for (const row of data ?? []) {
    const r = row as {
      id: string;
      status: ReviewJobSummary['status'];
      created_at: string;
      finished_at: string | null;
      review_queue: ReviewQueueEntry[] | null;
    };
    const queue = (r.review_queue ?? []) as ReviewQueueEntry[];
    if (queue.length === 0) continue;
    jobs.push({
      id: r.id,
      status: r.status,
      created_at: r.created_at,
      finished_at: r.finished_at,
      queue,
    });
  }
  return { ok: true, jobs };
}

const resolveSchema = z.object({
  jobId: z.string().uuid(),
  qboId: z.string().min(1),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('merge'), hhCustomerId: z.string().uuid() }),
    z.object({ kind: z.literal('create') }),
    z.object({ kind: z.literal('skip') }),
  ]),
});

export type ResolveReviewEntryInput = z.input<typeof resolveSchema>;

export type ResolveReviewEntryResult = { ok: true } | { ok: false; error: string };

export async function resolveReviewEntryAction(
  input: ResolveReviewEntryInput,
): Promise<ResolveReviewEntryResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { jobId, qboId, action } = parsed.data;

  const job = await loadImportJob(jobId);
  if (!job) return { ok: false, error: 'Import job not found.' };
  if (job.tenant_id !== tenant.id) {
    return { ok: false, error: 'Import job belongs to a different account.' };
  }

  const entry = job.review_queue.find((e) => e.qbo_id === qboId);
  if (!entry) return { ok: false, error: 'Review entry not found (already resolved?).' };

  const supabase = createAdminClient();

  if (action.kind === 'merge') {
    // Confirm the chosen HH customer belongs to this tenant + isn't deleted.
    const { data: target, error: targetErr } = await supabase
      .from('customers')
      .select('id, qbo_customer_id')
      .eq('id', action.hhCustomerId)
      .eq('tenant_id', tenant.id)
      .is('deleted_at', null)
      .maybeSingle();
    if (targetErr || !target) {
      return { ok: false, error: 'Selected HeyHenry customer not found.' };
    }
    if ((target.qbo_customer_id as string | null) && target.qbo_customer_id !== qboId) {
      return {
        ok: false,
        error: 'That customer is already linked to a different QBO record.',
      };
    }

    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('customers')
      .update({
        qbo_customer_id: qboId,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', action.hhCustomerId);
    if (updateErr) return { ok: false, error: `Failed to merge: ${updateErr.message}` };
  } else if (action.kind === 'create') {
    // Re-create the row from the snapshot the import worker stashed in
    // the queue entry. The job's customers batch may or may not exist
    // yet — bind the new row to the same batch if it does, so rollback
    // wipes them together; otherwise create a fresh batch row.
    const batchIdFromJob = (job.batch_ids as Record<string, string | undefined>).customers ?? null;
    const batchId = batchIdFromJob ?? (await createReviewQueueBatch(tenant.id, jobId));

    const now = new Date().toISOString();
    const { error: insertErr } = await supabase.from('customers').insert({
      tenant_id: tenant.id,
      kind: 'customer',
      // Without the original CompanyName signal we default to residential —
      // user can edit later.
      type: 'residential',
      name: entry.qbo_name.slice(0, 200),
      email: entry.qbo_email,
      phone: entry.qbo_phone,
      qbo_customer_id: qboId,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    });
    if (insertErr) {
      return { ok: false, error: `Failed to create customer: ${insertErr.message}` };
    }
  }
  // 'skip' has no DB side-effects beyond removing the queue entry below.

  // Remove the entry from the queue.
  const updatedQueue = job.review_queue.filter((e) => e.qbo_id !== qboId);
  const { error: queueErr } = await supabase
    .from('qbo_import_jobs')
    .update({ review_queue: updatedQueue, updated_at: new Date().toISOString() })
    .eq('id', jobId);
  if (queueErr) {
    return { ok: false, error: `Failed to update queue: ${queueErr.message}` };
  }

  revalidatePath('/settings/qbo-review');
  revalidatePath('/settings');
  return { ok: true };
}

async function createReviewQueueBatch(tenantId: string, jobId: string): Promise<string> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenantId,
      kind: 'customers',
      summary: { source: 'qbo_review_queue' },
      note: `QBO review-queue resolution for job ${jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create review-queue batch: ${error?.message ?? 'unknown'}`);
  }
  return data.id as string;
}
