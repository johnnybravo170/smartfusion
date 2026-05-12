/**
 * QBO import worker.
 *
 * Drives a chunked, resumable backfill from QBO into HeyHenry. The
 * runtime model:
 *
 *   - `runImport(input)` starts (or continues) a job. It walks
 *     `requested_entities` in order, importing one entity per pass.
 *   - Each page-level fetch checks a soft time budget. If exceeded,
 *     the worker saves the current entity + cursor, marks the job
 *     'queued', and returns. A per-minute cron picks it up next tick.
 *   - When all entities finish, the job is marked 'completed'.
 *
 * Idempotency: every importer is keyed on its QBO id, so a partially-
 * processed page being re-fetched on resume is a no-op for the
 * dedicated qbo_*_id unique index. The cursor saves API calls; safety
 * is not dependent on it being exact.
 *
 * Time budget: 240s default. Vercel Pro server actions max at 300s;
 * we leave 60s of headroom for the final state writes + response.
 */

import { qboQueryAll } from '@/lib/qbo/client';
import { loadConnection } from '@/lib/qbo/tokens';
import type {
  QboBill,
  QboCustomer,
  QboEstimate,
  QboInvoice,
  QboItem,
  QboPayment,
  QboPurchase,
  QboVendor,
} from '@/lib/qbo/types';
import { importBillPage, loadBillImportContext } from './bills';
import { importCustomerPage, loadCustomerImportContext } from './customers';
import { importEstimatePage, loadEstimateImportContext } from './estimates';
import { importInvoicePage, loadInvoiceImportContext } from './invoices';
import { importItemPage, loadItemImportContext } from './items';
import {
  bumpJobProgress,
  loadImportJob,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  pauseJobForResume,
  type QboImportEntity,
  setEntityCursor,
} from './job';
import { importPaymentPage, loadPaymentImportContext } from './payments';
import { importPurchasePage, loadPurchaseImportContext } from './purchases';
import { importVendorPage, loadVendorImportContext } from './vendors';

const DEFAULT_TIME_BUDGET_MS = 240_000;

export type RunImportInput = {
  tenantId: string;
  jobId: string;
  requestedEntities: QboImportEntity[];
  dateRangeFrom?: string | null;
  dateRangeTo?: string | null;
  /** Override the default soft time budget. Used by tests + the cron handler. */
  timeBudgetMs?: number;
};

export type RunImportResult = {
  ok: boolean;
  status: 'completed' | 'queued' | 'failed';
  error?: string;
};

/**
 * Run (or resume) an import. Marks the job 'running' → 'completed' or
 * 'queued' (chunk pause) or 'failed' (fatal). Returns the final status
 * so the caller knows whether cron needs to pick it up.
 */
export async function runImport(input: RunImportInput): Promise<RunImportResult> {
  const { tenantId, jobId } = input;
  const budgetMs = input.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const shouldStop = () => Date.now() >= deadline;

  const conn = await loadConnection(tenantId);
  if (!conn) {
    await markJobFailed(jobId, 'QBO is not connected for this tenant.');
    return { ok: false, status: 'failed', error: 'QBO is not connected for this tenant.' };
  }

  const job = await loadImportJob(jobId);
  if (!job) {
    return { ok: false, status: 'failed', error: 'Job not found.' };
  }

  await markJobRunning(jobId);

  try {
    // Resume from current_entity if set; otherwise start at the head
    // of requested_entities.
    const startIdx = job.current_entity
      ? Math.max(input.requestedEntities.indexOf(job.current_entity), 0)
      : 0;

    for (let i = startIdx; i < input.requestedEntities.length; i++) {
      const entity = input.requestedEntities[i];
      if (shouldStop()) {
        await pauseJobForResume(jobId, entity);
        return { ok: true, status: 'queued' };
      }
      try {
        const cursor =
          (job.entity_cursors as Partial<Record<QboImportEntity, number>>)[entity] ?? 1;
        const ranToCompletion = await runEntityImport(entity, input, cursor, shouldStop);
        if (!ranToCompletion) {
          // Budget exceeded mid-entity. Stay on this entity; cron resumes here.
          await pauseJobForResume(jobId, entity);
          return { ok: true, status: 'queued' };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[qbo.import] entity_failed', { jobId, entity, error: msg });
        await bumpJobProgress(jobId, entity, { failed: 1 });
        // Continue with the next entity — bookkeepers prefer partial
        // success ("got customers but not invoices") over a hard fail.
      }
    }

    await markJobCompleted(jobId);
    return { ok: true, status: 'completed' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[qbo.import] fatal', { jobId, error: msg });
    await markJobFailed(jobId, msg);
    return { ok: false, status: 'failed', error: msg };
  }
}

/**
 * Per-entity dispatcher. Returns `true` if the entity ran to completion
 * (no more pages), `false` if it bailed early due to budget.
 *
 * Each case follows the same shape:
 *   1. Load entity import context
 *   2. Iterate qboQueryAll with startPosition + onAdvanceCursor + shouldStop
 *   3. After each page, process it via the entity's importPage()
 *   4. After the iterator returns, bump api_calls_used + report done
 */
async function runEntityImport(
  entity: QboImportEntity,
  input: RunImportInput,
  startPosition: number,
  shouldStop: () => boolean,
): Promise<boolean> {
  const { tenantId, jobId, dateRangeFrom } = input;

  // Helper: every entity uses the same iterator wiring; only the
  // entity name + per-page processor differ. Returns true if we
  // exhausted the entity, false if we bailed on budget.
  async function runEntity<T>(
    qboEntity: string,
    where: string | undefined,
    processPage: (page: T[]) => Promise<void>,
  ): Promise<boolean> {
    let apiCalls = 0;
    let bailed = false;
    for await (const page of qboQueryAll<T>(tenantId, qboEntity, {
      where,
      startPosition,
      onApiCall: () => {
        apiCalls += 1;
      },
      onAdvanceCursor: async (next) => {
        await setEntityCursor(jobId, entity, next);
      },
      shouldStop: () => {
        if (shouldStop()) {
          bailed = true;
          return true;
        }
        return false;
      },
    })) {
      await processPage(page);
      if (shouldStop()) {
        bailed = true;
        break;
      }
    }
    if (apiCalls > 0) await bumpJobProgress(jobId, entity, {}, apiCalls);
    return !bailed;
  }

  const txnWhere = dateRangeFrom ? `TxnDate >= '${dateRangeFrom}'` : undefined;
  const metaWhere = dateRangeFrom
    ? `MetaData.LastUpdatedTime >= '${new Date(dateRangeFrom).toISOString()}'`
    : undefined;

  switch (entity) {
    case 'Customer': {
      const ctx = await loadCustomerImportContext(tenantId, jobId);
      return runEntity<QboCustomer>('Customer', metaWhere, (page) => importCustomerPage(ctx, page));
    }
    case 'Vendor': {
      const ctx = await loadVendorImportContext(tenantId, jobId);
      return runEntity<QboVendor>('Vendor', metaWhere, (page) => importVendorPage(ctx, page));
    }
    case 'Item': {
      const ctx = await loadItemImportContext(tenantId, jobId);
      // No date filter on items.
      return runEntity<QboItem>('Item', undefined, (page) => importItemPage(ctx, page));
    }
    case 'Invoice': {
      const ctx = await loadInvoiceImportContext(tenantId, jobId);
      return runEntity<QboInvoice>('Invoice', txnWhere, (page) => importInvoicePage(ctx, page));
    }
    case 'Estimate': {
      const ctx = await loadEstimateImportContext(tenantId, jobId);
      return runEntity<QboEstimate>('Estimate', txnWhere, (page) => importEstimatePage(ctx, page));
    }
    case 'Payment': {
      const ctx = await loadPaymentImportContext(tenantId, jobId);
      return runEntity<QboPayment>('Payment', txnWhere, (page) => importPaymentPage(ctx, page));
    }
    case 'Bill': {
      const ctx = await loadBillImportContext(tenantId, jobId);
      return runEntity<QboBill>('Bill', txnWhere, (page) => importBillPage(ctx, page));
    }
    case 'Purchase': {
      const job = await loadImportJob(jobId);
      const userId = job?.created_by ?? null;
      if (!userId) {
        throw new Error(
          'Cannot import purchases without a job creator (expenses.user_id is NOT NULL).',
        );
      }
      const ctx = await loadPurchaseImportContext(tenantId, jobId, userId);
      return runEntity<QboPurchase>('Purchase', txnWhere, (page) => importPurchasePage(ctx, page));
    }
    default:
      throw new Error(`Entity import not implemented yet: ${entity}`);
  }
}
