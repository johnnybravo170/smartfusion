/**
 * QBO import worker.
 *
 * Phase 4a scope: customers only. The shape is built so each future
 * entity is a one-function add — see `runEntityImport` for the contract.
 *
 * Execution model: synchronous within a server-action invocation. For
 * tenants with up to ~30k entities this fits in Vercel Pro's 300s
 * server-action budget at MAXRESULTS=1000. Larger imports will need
 * chunked/resumable execution — that's a follow-up card, not V1.
 */

import { qboQueryAll } from '@/lib/qbo/client';
import { loadConnection } from '@/lib/qbo/tokens';
import type { QboCustomer, QboInvoice, QboItem } from '@/lib/qbo/types';
import { importCustomerPage, loadCustomerImportContext } from './customers';
import { importInvoicePage, loadInvoiceImportContext } from './invoices';
import { importItemPage, loadItemImportContext } from './items';
import {
  bumpJobProgress,
  markJobCompleted,
  markJobFailed,
  markJobRunning,
  type QboImportEntity,
} from './job';

export type RunImportInput = {
  tenantId: string;
  jobId: string;
  requestedEntities: QboImportEntity[];
  dateRangeFrom?: string | null;
  dateRangeTo?: string | null;
};

/**
 * Drive a QBO import end-to-end against a `qbo_import_jobs` row. Marks
 * the job running → completed/failed and updates per-entity progress
 * along the way. Errors are swallowed at the entity level (one bad
 * entity doesn't tank the rest); only fatal errors (missing connection,
 * unauthorized) mark the job failed.
 */
export async function runImport(input: RunImportInput): Promise<{ ok: boolean; error?: string }> {
  const { tenantId, jobId } = input;

  const conn = await loadConnection(tenantId);
  if (!conn) {
    await markJobFailed(jobId, 'QBO is not connected for this tenant.');
    return { ok: false, error: 'QBO is not connected for this tenant.' };
  }

  await markJobRunning(jobId);

  try {
    for (const entity of input.requestedEntities) {
      try {
        await runEntityImport(entity, input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[qbo.import] entity_failed', { jobId, entity, error: msg });
        await bumpJobProgress(jobId, entity, { failed: 1 });
        // Continue with the next entity — bookkeepers prefer partial
        // success ("got customers but not invoices") over a hard fail.
      }
    }
    await markJobCompleted(jobId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[qbo.import] fatal', { jobId, error: msg });
    await markJobFailed(jobId, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Per-entity dispatcher. Adding a new entity is one switch case here
 * plus a `lib/qbo/import/{entity}.ts` module — no other wiring.
 */
async function runEntityImport(entity: QboImportEntity, input: RunImportInput): Promise<void> {
  const { tenantId, jobId, dateRangeFrom } = input;

  switch (entity) {
    case 'Customer': {
      const ctx = await loadCustomerImportContext(tenantId, jobId);
      let apiCalls = 0;
      const where = dateRangeFrom
        ? `MetaData.LastUpdatedTime >= '${new Date(dateRangeFrom).toISOString()}'`
        : undefined;
      for await (const page of qboQueryAll<QboCustomer>(tenantId, 'Customer', {
        where,
        onApiCall: () => {
          apiCalls += 1;
        },
      })) {
        await importCustomerPage(ctx, page);
      }
      if (apiCalls > 0) await bumpJobProgress(jobId, entity, {}, apiCalls);
      return;
    }

    case 'Item': {
      const ctx = await loadItemImportContext(tenantId, jobId);
      let apiCalls = 0;
      // No date filter for items — pricebook is small and infrequently
      // touched; pulling them all every time is cheap.
      for await (const page of qboQueryAll<QboItem>(tenantId, 'Item', {
        onApiCall: () => {
          apiCalls += 1;
        },
      })) {
        await importItemPage(ctx, page);
      }
      if (apiCalls > 0) await bumpJobProgress(jobId, entity, {}, apiCalls);
      return;
    }

    case 'Invoice': {
      const ctx = await loadInvoiceImportContext(tenantId, jobId);
      let apiCalls = 0;
      // Date filter on TxnDate (transaction date) — what the user
      // actually means by "last 2 years" is the invoice date, not the
      // last-touched timestamp.
      const where = dateRangeFrom ? `TxnDate >= '${dateRangeFrom}'` : undefined;
      for await (const page of qboQueryAll<QboInvoice>(tenantId, 'Invoice', {
        where,
        onApiCall: () => {
          apiCalls += 1;
        },
      })) {
        await importInvoicePage(ctx, page);
      }
      if (apiCalls > 0) await bumpJobProgress(jobId, entity, {}, apiCalls);
      return;
    }

    // Vendor / Payment / Estimate / Bill / Purchase land in 4c.
    default:
      throw new Error(`Entity import not implemented yet: ${entity}`);
  }
}
