/**
 * GET /api/cron/qbo-import-resume
 *
 * Per-minute tick that drives chunked QBO import jobs to completion.
 * Finds any `qbo_import_jobs` row with status='queued' AND
 * current_entity set, then calls the worker with the saved cursor.
 * The worker runs for its time budget (~240s) and either finishes
 * the job or pauses again — either way, this route returns the per-
 * job final status.
 *
 * Concurrency: serial. We pick up at most `MAX_PER_TICK` jobs per
 * invocation to keep the cron tick bounded. With Vercel's 60s
 * function default for cron routes, plus 240s worker budgets per job,
 * we can't realistically process more than 1 job per tick anyway —
 * MAX_PER_TICK is mostly a safety belt.
 *
 * Auth: Bearer ${CRON_SECRET} (same pattern as other cron routes).
 */

import { listResumableJobs, type QboImportEntity } from '@/lib/qbo/import/job';
import { runImport } from '@/lib/qbo/import/worker';

export const dynamic = 'force-dynamic';
// Vercel cron functions max at 300s on Pro. Match the worker budget +
// a small writeback margin.
export const maxDuration = 300;

const MAX_PER_TICK = 1;

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const jobs = await listResumableJobs(MAX_PER_TICK);
  if (jobs.length === 0) {
    return Response.json({ ok: true, resumed: 0 });
  }

  const results: Array<{ jobId: string; status: string; error?: string }> = [];
  for (const job of jobs) {
    try {
      const result = await runImport({
        tenantId: job.tenant_id,
        jobId: job.id,
        requestedEntities: job.requested_entities as QboImportEntity[],
        dateRangeFrom: job.date_range_from,
        dateRangeTo: job.date_range_to,
        // Leave headroom for writebacks before maxDuration hits.
        timeBudgetMs: 240_000,
      });
      results.push({ jobId: job.id, status: result.status, error: result.error });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[qbo.cron] resume_failed', { jobId: job.id, error: msg });
      results.push({ jobId: job.id, status: 'crash', error: msg });
    }
  }

  return Response.json({ ok: true, resumed: results.length, results });
}
