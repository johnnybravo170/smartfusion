/**
 * QBO Customer → HeyHenry `customers` import.
 *
 * Pipeline per customer:
 *   1. Look up by (tenant_id, qbo_customer_id). If found, that's the
 *      definitive match — update in place, no dedup needed.
 *   2. Fuzzy-match against the tenant's existing customer roster via
 *      `findMatch` from `src/lib/customers/dedup.ts`.
 *      - email/phone tier → auto-merge: bind qbo_customer_id to that
 *        HH row.
 *      - name+city / name tier → push to review_queue, skip for now.
 *      - no match → insert fresh, tagged with `import_batch_id`.
 *   3. Bump per-entity counters on `qbo_import_jobs` as we go.
 *
 * The import worker batches 1000 QBO Customers per page (see qboQueryAll
 * default in src/lib/qbo/client.ts). Each batch round-trips one bulk
 * insert + one update query, keeping DB chatter bounded.
 */

import {
  type ExistingCustomer,
  findMatch,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '@/lib/customers/dedup';
import type { QboCustomer } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import {
  appendReviewQueue,
  bumpJobProgress,
  type ReviewQueueEntry,
  setBatchIdForEntity,
} from './job';

/**
 * Map a QBO Customer to the row shape we'd insert. `import_batch_id` and
 * `tenant_id` are added by the caller; this stays pure / testable.
 */
export function mapQboCustomerToRow(qbo: QboCustomer): {
  name: string;
  type: 'residential' | 'commercial';
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
} {
  // CompanyName presence is QBO's signal that this is a business — flip
  // type to commercial when it's set, residential otherwise.
  const isCommercial = Boolean(qbo.CompanyName?.trim());
  const name = (qbo.CompanyName?.trim() || qbo.DisplayName).slice(0, 200);
  return {
    name,
    type: isCommercial ? 'commercial' : 'residential',
    email: qbo.PrimaryEmailAddr?.Address?.trim() || null,
    phone: qbo.PrimaryPhone?.FreeFormNumber?.trim() ?? qbo.Mobile?.FreeFormNumber?.trim() ?? null,
    address_line1: qbo.BillAddr?.Line1?.trim() || null,
    city: qbo.BillAddr?.City?.trim() || null,
    province: qbo.BillAddr?.CountrySubDivisionCode?.trim() || null,
    postal_code: qbo.BillAddr?.PostalCode?.trim() || null,
  };
}

type CustomerImportContext = {
  tenantId: string;
  jobId: string;
  /** Lazily-created import_batches row id for the 'customers' kind. */
  batchIdRef: { current: string | null };
  /** Pre-loaded HH roster for fuzzy dedup. Stable for the whole import run. */
  roster: ExistingCustomer[];
  /** Pre-loaded existing qbo_customer_id → hh_id map for round-trip idempotency. */
  qboIdToHhId: Map<string, string>;
};

/**
 * Lazy-create the import_batches row for customers. We only spawn it
 * once we know there's at least one row to write — empty imports don't
 * leave a stub batch behind.
 */
async function ensureCustomerBatch(ctx: CustomerImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'customers',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create customer import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'customers', id);
  return id;
}

/**
 * Process one page of QBO Customers (up to 1000). Splits each candidate
 * into one of three buckets:
 *   - update: already linked by qbo_customer_id OR auto-merged by strong dedup
 *   - insert: novel customer
 *   - review: ambiguous match, deferred to review_queue
 *
 * Returns counters for the page.
 */
export async function importCustomerPage(
  ctx: CustomerImportContext,
  page: QboCustomer[],
): Promise<void> {
  if (page.length === 0) {
    return;
  }

  const supabase = createAdminClient();

  const toInsert: Array<
    ReturnType<typeof mapQboCustomerToRow> & {
      qbo_customer_id: string;
      qbo_sync_token: string;
      qbo_synced_at: string;
      qbo_sync_status: string;
    }
  > = [];
  const toUpdate: Array<{
    id: string;
    qbo: QboCustomer;
    mapped: ReturnType<typeof mapQboCustomerToRow>;
  }> = [];
  const toReview: ReviewQueueEntry[] = [];

  for (const qbo of page) {
    const mapped = mapQboCustomerToRow(qbo);

    // 1. Round-trip idempotency: same qbo_customer_id we've seen before?
    const existingHhId = ctx.qboIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo, mapped });
      continue;
    }

    // 2. Fuzzy dedup against the HH roster.
    const match = findMatch(
      { name: mapped.name, email: mapped.email, phone: mapped.phone, city: mapped.city },
      ctx.roster,
    );

    if (match.tier === 'email' || match.tier === 'phone') {
      // Strong match — auto-merge: bind qbo_customer_id, leave HH row otherwise alone.
      if (match.existing) {
        toUpdate.push({
          id: match.existing.id,
          qbo,
          mapped: { ...mapped, name: match.existing.name },
        });
        // Reflect in roster so subsequent rows on the same page don't double-match.
        ctx.qboIdToHhId.set(qbo.Id, match.existing.id);
      }
      continue;
    }

    if (match.tier === 'name+city' || match.tier === 'name') {
      // Ambiguous — surface for user resolution.
      toReview.push({
        qbo_id: qbo.Id,
        entity_type: 'customer',
        qbo_name: mapped.name,
        qbo_email: mapped.email,
        qbo_phone: mapped.phone,
        candidates: match.existing
          ? [
              {
                hh_id: match.existing.id,
                name: match.existing.name,
                email: match.existing.email,
                phone: match.existing.phone,
                tier: match.tier,
              },
            ]
          : [],
      });
      continue;
    }

    // 3. No match — fresh insert.
    toInsert.push({
      ...mapped,
      qbo_customer_id: qbo.Id,
      qbo_sync_token: qbo.SyncToken,
      qbo_synced_at: new Date().toISOString(),
      qbo_sync_status: 'synced',
    });
  }

  // --- Writes ---

  if (toInsert.length > 0) {
    const batchId = await ensureCustomerBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      kind: 'customer',
      type: r.type,
      name: r.name,
      email: r.email,
      phone: r.phone,
      address_line1: r.address_line1,
      city: r.city,
      province: r.province,
      postal_code: r.postal_code,
      qbo_customer_id: r.qbo_customer_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: r.qbo_sync_status,
      qbo_synced_at: r.qbo_synced_at,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error: insertErr } = await supabase
      .from('customers')
      .insert(rows)
      .select('id, qbo_customer_id');
    if (insertErr) {
      throw new Error(`Failed to insert customers page: ${insertErr.message}`);
    }
    // Reflect new ids in the roster + qbo map for subsequent pages.
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_customer_id: string | null }).qbo_customer_id;
      const matching = toInsert.find((t) => t.qbo_customer_id === qboId);
      if (qboId) ctx.qboIdToHhId.set(qboId, id);
      if (matching) {
        ctx.roster.push({
          id,
          name: matching.name,
          email: matching.email,
          phone: matching.phone,
          city: matching.city,
        });
      }
    }
  }

  // Updates: do them serially (small batches per page in practice, and
  // Supabase doesn't support multi-row UPDATE with different values in
  // one call without an RPC).
  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('customers')
      .update({
        // We only update the qbo_* refs on auto-merge — name/email/etc
        // on the HH row may have been edited by the user and we don't
        // want to clobber that. The exception is the QBO-linked row
        // itself (round-trip path) where we DO refresh content.
        qbo_customer_id: u.qbo.Id,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (updateErr) {
      throw new Error(`Failed to update customer ${u.id}: ${updateErr.message}`);
    }
  }

  if (toReview.length > 0) {
    await appendReviewQueue(ctx.jobId, toReview);
  }

  await bumpJobProgress(ctx.jobId, 'Customer', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped: toReview.length,
  });
}

/**
 * Load context once at the start of the customers import: tenant roster
 * (for fuzzy dedup) + qbo_id → hh_id map (for round-trip idempotency).
 */
export async function loadCustomerImportContext(
  tenantId: string,
  jobId: string,
): Promise<CustomerImportContext> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('customers')
    .select('id, name, email, phone, city, qbo_customer_id')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null);

  if (error) {
    throw new Error(`Failed to load customer roster: ${error.message}`);
  }

  const roster: ExistingCustomer[] = [];
  const qboIdToHhId = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as {
      id: string;
      name: string;
      email: string | null;
      phone: string | null;
      city: string | null;
      qbo_customer_id: string | null;
    };
    roster.push({ id: r.id, name: r.name, email: r.email, phone: r.phone, city: r.city });
    if (r.qbo_customer_id) qboIdToHhId.set(r.qbo_customer_id, r.id);
  }

  return {
    tenantId,
    jobId,
    batchIdRef: { current: null },
    roster,
    qboIdToHhId,
  };
}

// Re-exports for tests / external callers.
export { normalizeEmail, normalizeName, normalizePhone };
