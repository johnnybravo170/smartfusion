/**
 * QBO Vendor → HeyHenry `customers` import (with kind='vendor').
 *
 * Vendors share the `customers` table with customers, sub-trades,
 * inspectors, etc. — the `kind` discriminator decides which detail-page
 * sections apply. We re-use the existing `qbo_customer_id` column for
 * round-trip idempotency since QBO Vendor and Customer Ids are drawn
 * from the same global namespace inside a QBO company.
 *
 * Dedup is simpler than for customers: no fuzzy match against the
 * existing roster. Vendor names overlap heavily ("Home Depot" exists
 * for every contractor), and a strong email/phone match against a
 * customer-kind row would silently flip its kind, which would corrupt
 * the operational meaning. So: insert fresh, or update existing
 * qbo-linked row.
 */

import type { QboVendor } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

export function mapQboVendorToRow(qbo: QboVendor): {
  name: string;
  email: string | null;
  phone: string | null;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
} {
  const name = (qbo.CompanyName?.trim() || qbo.DisplayName).slice(0, 200);
  return {
    name,
    email: qbo.PrimaryEmailAddr?.Address?.trim() || null,
    phone: qbo.PrimaryPhone?.FreeFormNumber?.trim() ?? qbo.Mobile?.FreeFormNumber?.trim() ?? null,
    address_line1: qbo.BillAddr?.Line1?.trim() || null,
    city: qbo.BillAddr?.City?.trim() || null,
    province: qbo.BillAddr?.CountrySubDivisionCode?.trim() || null,
    postal_code: qbo.BillAddr?.PostalCode?.trim() || null,
  };
}

type VendorImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  qboIdToHhId: Map<string, string>;
};

async function ensureVendorBatch(ctx: VendorImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'vendors',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create vendor import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'vendors', id);
  return id;
}

export async function importVendorPage(ctx: VendorImportContext, page: QboVendor[]): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  const toInsert: Array<
    ReturnType<typeof mapQboVendorToRow> & { qbo_customer_id: string; qbo_sync_token: string }
  > = [];
  const toUpdate: Array<{ id: string; qbo: QboVendor }> = [];

  for (const qbo of page) {
    const mapped = mapQboVendorToRow(qbo);
    const existingHhId = ctx.qboIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, qbo });
    } else {
      toInsert.push({ ...mapped, qbo_customer_id: qbo.Id, qbo_sync_token: qbo.SyncToken });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensureVendorBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      kind: 'vendor',
      // type column must be NULL for non-customer kinds (CHECK constraint).
      type: null,
      name: r.name,
      email: r.email,
      phone: r.phone,
      address_line1: r.address_line1,
      city: r.city,
      province: r.province,
      postal_code: r.postal_code,
      qbo_customer_id: r.qbo_customer_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
      created_at: now,
      updated_at: now,
    }));
    const { data: inserted, error } = await supabase
      .from('customers')
      .insert(rows)
      .select('id, qbo_customer_id');
    if (error) {
      throw new Error(`Failed to insert vendors page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_customer_id: string | null }).qbo_customer_id;
      if (qboId) ctx.qboIdToHhId.set(qboId, id);
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('customers')
      .update({
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update vendor ${u.id}: ${error.message}`);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Vendor', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
  });
}

export async function loadVendorImportContext(
  tenantId: string,
  jobId: string,
): Promise<VendorImportContext> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('customers')
    .select('id, qbo_customer_id')
    .eq('tenant_id', tenantId)
    .eq('kind', 'vendor')
    .not('qbo_customer_id', 'is', null)
    .is('deleted_at', null);
  if (error) {
    throw new Error(`Failed to load vendor roster: ${error.message}`);
  }
  const qboIdToHhId = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as { id: string; qbo_customer_id: string | null };
    if (r.qbo_customer_id) qboIdToHhId.set(r.qbo_customer_id, r.id);
  }
  return { tenantId, jobId, batchIdRef: { current: null }, qboIdToHhId };
}
