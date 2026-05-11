'use server';

/**
 * Server actions for the QBO import flow.
 *
 * `startQboImportAction` is the user-facing kickoff — creates a
 * `qbo_import_jobs` row, then drives the worker synchronously within
 * the same request. Returns the job id so the UI can poll for progress
 * (or render the final summary if it's small enough to fit in one
 * request).
 *
 * `cancelQboImportAction` flips a running job to 'cancelled' (the
 * worker checks this between pages and bails out gracefully — once
 * cron-driven resume lands).
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createImportJob, loadImportJob, type QboImportEntity } from '@/lib/qbo/import/job';
import { runImport } from '@/lib/qbo/import/worker';
import { loadConnection } from '@/lib/qbo/tokens';
import { createAdminClient } from '@/lib/supabase/admin';

const SUPPORTED_ENTITIES: QboImportEntity[] = [
  'Customer',
  'Vendor',
  'Item',
  'Invoice',
  'Payment',
  'Estimate',
  'Bill',
  'Purchase',
];

const startSchema = z.object({
  entities: z.array(z.enum(SUPPORTED_ENTITIES as [QboImportEntity, ...QboImportEntity[]])).min(1),
  dateRangeFrom: z.string().date().optional().nullable(),
  dateRangeTo: z.string().date().optional().nullable(),
});

export type StartQboImportInput = z.input<typeof startSchema>;

export type StartQboImportResult = { ok: true; jobId: string } | { ok: false; error: string };

export async function startQboImportAction(
  input: StartQboImportInput,
): Promise<StartQboImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const conn = await loadConnection(tenant.id);
  if (!conn) {
    return { ok: false, error: 'Connect QuickBooks first, then start an import.' };
  }

  const parsed = startSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid import options.',
    };
  }

  // Don't allow a second job to start while one is already running for
  // this tenant — the worker isn't built for concurrent runs against
  // the same tenant row (yet).
  if (await hasActiveImportJob(tenant.id)) {
    return {
      ok: false,
      error: 'An import is already running for this account. Wait for it to finish.',
    };
  }

  const user = await getCurrentUser();
  const job = await createImportJob({
    tenantId: tenant.id,
    requestedEntities: parsed.data.entities,
    dateRangeFrom: parsed.data.dateRangeFrom ?? null,
    dateRangeTo: parsed.data.dateRangeTo ?? null,
    createdBy: user?.id ?? null,
  });

  // Drive the worker synchronously — caller's server-action timeout
  // bounds total wall time. For long imports this will start chunking
  // when cron-resume lands; for V1 we trade simplicity for occasional
  // timeouts that the user re-triggers (idempotent).
  const result = await runImport({
    tenantId: tenant.id,
    jobId: job.id,
    requestedEntities: parsed.data.entities,
    dateRangeFrom: parsed.data.dateRangeFrom ?? null,
    dateRangeTo: parsed.data.dateRangeTo ?? null,
  });

  revalidatePath('/settings');
  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Import failed.' };
  }
  return { ok: true, jobId: job.id };
}

async function hasActiveImportJob(tenantId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('qbo_import_jobs')
    .select('id')
    .eq('tenant_id', tenantId)
    .in('status', ['queued', 'running'])
    .limit(1);
  return Boolean(data && data.length > 0);
}

export type FetchImportJobResult =
  | { ok: true; job: NonNullable<Awaited<ReturnType<typeof loadImportJob>>> }
  | { ok: false; error: string };

export async function fetchImportJobAction(jobId: string): Promise<FetchImportJobResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in.' };
  }
  const job = await loadImportJob(jobId);
  if (!job) {
    return { ok: false, error: 'Import job not found.' };
  }
  if (job.tenant_id !== tenant.id) {
    return { ok: false, error: 'Import job belongs to a different account.' };
  }
  return { ok: true, job };
}
