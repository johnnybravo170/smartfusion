import { createClient } from '@/lib/supabase/server';

export type LabourRateRow = {
  id: string;
  tenant_id: string;
  trade: string;
  role: string;
  cost_per_hour_cents: number;
  bill_per_hour_cents: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

const COLS =
  'id, tenant_id, trade, role, cost_per_hour_cents, bill_per_hour_cents, is_active, created_at, updated_at';

export async function listLabourRates(includeInactive = false): Promise<LabourRateRow[]> {
  const supabase = await createClient();
  let q = supabase.from('labour_rates').select(COLS);
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q.order('trade').order('role');
  if (error) throw new Error(`Failed to list labour rates: ${error.message}`);
  return (data ?? []) as LabourRateRow[];
}
