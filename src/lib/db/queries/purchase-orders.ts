import { createClient } from '@/lib/supabase/server';

export type PurchaseOrderStatus = 'draft' | 'sent' | 'acknowledged' | 'received' | 'closed';

export type PurchaseOrderItemRow = {
  id: string;
  po_id: string;
  cost_line_id: string | null;
  /** Resolved from cost_line.budget_category_id when cost_line_id is set —
   *  null for free-text PO line items not tied to a budgeted line. */
  budget_category_id: string | null;
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
  'id, po_id, cost_line_id, label, qty, unit, unit_cost_cents, line_total_cents, received_qty, created_at, project_cost_lines:cost_line_id(budget_category_id)';

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
  for (const raw of items ?? []) {
    const item = raw as unknown as Omit<PurchaseOrderItemRow, 'budget_category_id'> & {
      project_cost_lines:
        | { budget_category_id: string | null }
        | { budget_category_id: string | null }[]
        | null;
    };
    // PostgREST returns the joined relation as an array even for 1:1 FKs.
    const linked = Array.isArray(item.project_cost_lines)
      ? item.project_cost_lines[0]
      : item.project_cost_lines;
    const flattened: PurchaseOrderItemRow = {
      id: item.id,
      po_id: item.po_id,
      cost_line_id: item.cost_line_id,
      budget_category_id: linked?.budget_category_id ?? null,
      label: item.label,
      qty: item.qty,
      unit: item.unit,
      unit_cost_cents: item.unit_cost_cents,
      line_total_cents: item.line_total_cents,
      received_qty: item.received_qty,
      created_at: item.created_at,
    };
    const arr = itemsByPo.get(item.po_id);
    if (arr) arr.push(flattened);
    else itemsByPo.set(item.po_id, [flattened]);
  }

  return pos.map((po) => ({
    ...(po as Omit<PurchaseOrderRow, 'items'>),
    items: itemsByPo.get(po.id as string) ?? [],
  }));
}
