import { createClient } from '@/lib/supabase/server';

export type PurchaseOrderStatus = 'draft' | 'sent' | 'acknowledged' | 'received' | 'closed';

export type PurchaseOrderItemRow = {
  id: string;
  po_id: string;
  cost_line_id: string | null;
  label: string;
  qty: number;
  unit: string;
  unit_cost_cents: number;
  line_total_cents: number;
  received_qty: number;
  created_at: string;
};

export type PurchaseOrderRow = {
  id: string;
  tenant_id: string;
  project_id: string;
  vendor: string;
  po_number: string | null;
  status: PurchaseOrderStatus;
  issued_date: string | null;
  expected_date: string | null;
  notes: string | null;
  total_cents: number;
  created_at: string;
  updated_at: string;
  items: PurchaseOrderItemRow[];
};

const PO_COLS =
  'id, tenant_id, project_id, vendor, po_number, status, issued_date, expected_date, notes, total_cents, created_at, updated_at';

const POI_COLS =
  'id, po_id, cost_line_id, label, qty, unit, unit_cost_cents, line_total_cents, received_qty, created_at';

export async function listPurchaseOrders(projectId: string): Promise<PurchaseOrderRow[]> {
  const supabase = await createClient();

  const { data: pos, error } = await supabase
    .from('purchase_orders')
    .select(PO_COLS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`Failed to list purchase orders: ${error.message}`);
  if (!pos || pos.length === 0) return [];

  const poIds = pos.map((p) => p.id as string);
  const { data: items } = await supabase
    .from('purchase_order_items')
    .select(POI_COLS)
    .in('po_id', poIds)
    .order('created_at');

  const itemsByPo = new Map<string, PurchaseOrderItemRow[]>();
  for (const item of items ?? []) {
    const poId = item.po_id as string;
    if (!itemsByPo.has(poId)) itemsByPo.set(poId, []);
    itemsByPo.get(poId)?.push(item as PurchaseOrderItemRow);
  }

  return pos.map((po) => ({
    ...(po as Omit<PurchaseOrderRow, 'items'>),
    items: itemsByPo.get(po.id as string) ?? [],
  }));
}
