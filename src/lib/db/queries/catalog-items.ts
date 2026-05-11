/**
 * Pricebook (`catalog_items`) read paths.
 *
 * Server actions for CRUD live in `src/server/actions/catalog-items.ts`.
 * The cutover from `service_catalog` happens in PR #3 of the Pricebook
 * epic; for now both tables coexist.
 */

import { createClient } from '@/lib/supabase/server';

export type CatalogItemRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  sku: string | null;
  pricing_model: 'fixed' | 'per_unit' | 'hourly' | 'time_and_materials';
  unit_label: string | null;
  unit_price_cents: number | null;
  min_charge_cents: number | null;
  is_taxable: boolean;
  category: 'labor' | 'materials' | 'service' | 'inventory' | 'other' | null;
  surface_type: string | null;
  is_active: boolean;
  qbo_item_id: string | null;
  qbo_sync_token: string | null;
  qbo_sync_status: string | null;
  qbo_synced_at: string | null;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

const COLUMNS =
  'id, tenant_id, name, description, sku, pricing_model, unit_label, unit_price_cents, min_charge_cents, is_taxable, category, surface_type, is_active, qbo_item_id, qbo_sync_token, qbo_sync_status, qbo_synced_at, import_batch_id, created_at, updated_at';

export type ListCatalogItemsOpts = {
  /** When true (default), only returns is_active=true rows. */
  activeOnly?: boolean;
  /** Filter to a single surface_type (legacy pressure-washing flows). */
  surfaceType?: string;
};

export async function listCatalogItems(opts: ListCatalogItemsOpts = {}): Promise<CatalogItemRow[]> {
  const supabase = await createClient();
  let query = supabase.from('catalog_items').select(COLUMNS);

  if (opts.activeOnly !== false) {
    query = query.eq('is_active', true);
  }
  if (opts.surfaceType) {
    query = query.eq('surface_type', opts.surfaceType);
  }

  const { data, error } = await query.order('name', { ascending: true });
  if (error) {
    throw new Error(`Failed to list catalog items: ${error.message}`);
  }
  return (data ?? []) as CatalogItemRow[];
}

export async function getCatalogItem(id: string): Promise<CatalogItemRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('catalog_items')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load catalog item: ${error.message}`);
  }
  return (data as CatalogItemRow | null) ?? null;
}

/**
 * Find a catalog item by its QBO Id. Used by the import worker for
 * idempotent re-import — match QBO Item.Id → existing catalog_item row.
 */
export async function getCatalogItemByQboId(
  tenantId: string,
  qboItemId: string,
): Promise<CatalogItemRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('catalog_items')
    .select(COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('qbo_item_id', qboItemId)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Failed to load catalog item by QBO id: ${error.message}`);
  }
  return (data as CatalogItemRow | null) ?? null;
}
