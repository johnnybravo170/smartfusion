/**
 * QBO Item → HeyHenry `catalog_items` import.
 *
 * Mapping:
 *   - Service item with a non-zero UnitPrice → pricing_model='fixed'
 *   - Service item with zero/missing UnitPrice → pricing_model='time_and_materials'
 *   - Inventory / NonInventory item → pricing_model='fixed' (a unit
 *     price exists; the line on an invoice will multiply by qty)
 *   - Type='Group' or 'Category' → skipped (organizational, not billable)
 *
 * Idempotency: keyed on (tenant_id, qbo_item_id). Re-running updates
 * the catalog_items row in place rather than inserting a duplicate.
 *
 * Items don't fuzzy-dedup against existing HH catalog_items entries.
 * QBO is the source of truth for items once a contractor has connected,
 * and HH pricebook entries the user created manually stay separate
 * (different names live side-by-side).
 */

import type { QboItem } from '@/lib/qbo/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { bumpJobProgress, setBatchIdForEntity } from './job';

type CatalogPricingModel = 'fixed' | 'per_unit' | 'hourly' | 'time_and_materials';

export type MappedCatalogItem = {
  name: string;
  description: string | null;
  sku: string | null;
  pricing_model: CatalogPricingModel;
  unit_label: string | null;
  unit_price_cents: number | null;
  is_taxable: boolean;
  category: 'service' | 'materials' | 'inventory' | 'labor' | 'other' | null;
  is_active: boolean;
};

export function mapQboItemToRow(qbo: QboItem): MappedCatalogItem | null {
  // Group / Category items are structural in QBO and don't carry
  // standalone prices; the bookkeeper sees them grouped on invoices.
  // Skip — they'd just clutter the pricebook.
  if (qbo.Type === 'Group' || qbo.Type === 'Category') {
    return null;
  }

  const hasUnitPrice = typeof qbo.UnitPrice === 'number' && qbo.UnitPrice > 0;
  const unitPriceCents = hasUnitPrice ? Math.round((qbo.UnitPrice ?? 0) * 100) : null;

  // Service-type items with no fixed price are T&M (contractor sets
  // amount per job). Everything else is a flat rate.
  let pricingModel: CatalogPricingModel;
  if (qbo.Type === 'Service' && !hasUnitPrice) {
    pricingModel = 'time_and_materials';
  } else {
    pricingModel = 'fixed';
  }

  const category: MappedCatalogItem['category'] =
    qbo.Type === 'Service'
      ? 'service'
      : qbo.Type === 'Inventory'
        ? 'inventory'
        : qbo.Type === 'NonInventory'
          ? 'materials'
          : null;

  return {
    name: qbo.Name.slice(0, 200),
    description: qbo.Description?.trim() || null,
    sku: qbo.Sku?.trim() || null,
    pricing_model: pricingModel,
    // catalog_items.unit_label is meaningful for per_unit/hourly only —
    // leave NULL for fixed and T&M so the UI doesn't render a "/unit".
    unit_label: null,
    unit_price_cents: pricingModel === 'time_and_materials' ? null : unitPriceCents,
    is_taxable: qbo.Taxable ?? true,
    category,
    is_active: qbo.Active ?? true,
  };
}

type ItemImportContext = {
  tenantId: string;
  jobId: string;
  batchIdRef: { current: string | null };
  qboIdToHhId: Map<string, string>;
};

async function ensureItemBatch(ctx: ItemImportContext): Promise<string> {
  if (ctx.batchIdRef.current) return ctx.batchIdRef.current;
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: ctx.tenantId,
      kind: 'items',
      summary: { source: 'qbo' },
      note: `QBO import job ${ctx.jobId}`,
    })
    .select('id')
    .single();
  if (error || !data) {
    throw new Error(`Failed to create items import batch: ${error?.message ?? 'unknown'}`);
  }
  const id = data.id as string;
  ctx.batchIdRef.current = id;
  await setBatchIdForEntity(ctx.jobId, 'items', id);
  return id;
}

export async function importItemPage(ctx: ItemImportContext, page: QboItem[]): Promise<void> {
  if (page.length === 0) return;
  const supabase = createAdminClient();

  const toInsert: Array<MappedCatalogItem & { qbo_item_id: string; qbo_sync_token: string }> = [];
  const toUpdate: Array<{ id: string; mapped: MappedCatalogItem; qbo: QboItem }> = [];
  let skipped = 0;

  for (const qbo of page) {
    const mapped = mapQboItemToRow(qbo);
    if (!mapped) {
      skipped += 1;
      continue;
    }
    const existingHhId = ctx.qboIdToHhId.get(qbo.Id);
    if (existingHhId) {
      toUpdate.push({ id: existingHhId, mapped, qbo });
    } else {
      toInsert.push({ ...mapped, qbo_item_id: qbo.Id, qbo_sync_token: qbo.SyncToken });
    }
  }

  if (toInsert.length > 0) {
    const batchId = await ensureItemBatch(ctx);
    const now = new Date().toISOString();
    const rows = toInsert.map((r) => ({
      tenant_id: ctx.tenantId,
      name: r.name,
      description: r.description,
      sku: r.sku,
      pricing_model: r.pricing_model,
      unit_label: r.unit_label,
      unit_price_cents: r.unit_price_cents,
      min_charge_cents: null,
      is_taxable: r.is_taxable,
      category: r.category,
      surface_type: null,
      is_active: r.is_active,
      qbo_item_id: r.qbo_item_id,
      qbo_sync_token: r.qbo_sync_token,
      qbo_sync_status: 'synced',
      qbo_synced_at: now,
      import_batch_id: batchId,
    }));
    const { data: inserted, error } = await supabase
      .from('catalog_items')
      .insert(rows)
      .select('id, qbo_item_id');
    if (error) {
      throw new Error(`Failed to insert catalog_items page: ${error.message}`);
    }
    for (const r of inserted ?? []) {
      const id = (r as { id: string }).id;
      const qboId = (r as { qbo_item_id: string | null }).qbo_item_id;
      if (qboId) ctx.qboIdToHhId.set(qboId, id);
    }
  }

  for (const u of toUpdate) {
    const now = new Date().toISOString();
    const { error } = await supabase
      .from('catalog_items')
      .update({
        name: u.mapped.name,
        description: u.mapped.description,
        sku: u.mapped.sku,
        pricing_model: u.mapped.pricing_model,
        unit_label: u.mapped.unit_label,
        unit_price_cents: u.mapped.unit_price_cents,
        is_taxable: u.mapped.is_taxable,
        category: u.mapped.category,
        is_active: u.mapped.is_active,
        qbo_sync_token: u.qbo.SyncToken,
        qbo_sync_status: 'synced',
        qbo_synced_at: now,
        updated_at: now,
      })
      .eq('id', u.id);
    if (error) {
      throw new Error(`Failed to update catalog_items ${u.id}: ${error.message}`);
    }
  }

  await bumpJobProgress(ctx.jobId, 'Item', {
    fetched: page.length,
    imported: toInsert.length + toUpdate.length,
    skipped,
  });
}

export async function loadItemImportContext(
  tenantId: string,
  jobId: string,
): Promise<ItemImportContext> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('catalog_items')
    .select('id, qbo_item_id')
    .eq('tenant_id', tenantId)
    .not('qbo_item_id', 'is', null);
  if (error) {
    throw new Error(`Failed to load catalog_items roster: ${error.message}`);
  }
  const qboIdToHhId = new Map<string, string>();
  for (const row of data ?? []) {
    const r = row as { id: string; qbo_item_id: string | null };
    if (r.qbo_item_id) qboIdToHhId.set(r.qbo_item_id, r.id);
  }
  return { tenantId, jobId, batchIdRef: { current: null }, qboIdToHhId };
}
