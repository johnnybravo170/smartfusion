import { createClient } from '@/lib/supabase/server';

export type MaterialsCatalogRow = {
  id: string;
  tenant_id: string;
  category: 'material' | 'labour' | 'sub' | 'equipment' | 'overhead';
  cost_code: string | null;
  label: string;
  description: string | null;
  unit: string;
  unit_cost_cents: number;
  unit_price_cents: number;
  markup_pct: number;
  vendor: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const COLS =
  'id, tenant_id, category, cost_code, label, description, unit, unit_cost_cents, unit_price_cents, markup_pct, vendor, is_active, created_at, updated_at';

export async function listMaterialsCatalog(
  includeInactive = false,
): Promise<MaterialsCatalogRow[]> {
  const supabase = await createClient();
  let q = supabase.from('materials_catalog').select(COLS);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('category').order('label');
  if (error) throw new Error(`Failed to list materials catalog: ${error.message}`);
  return (data ?? []) as MaterialsCatalogRow[];
}
