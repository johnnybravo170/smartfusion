'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type CostControlResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

// ─── Cost lines ───────────────────────────────────────────────────────────────

const costLineSchema = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  bucket_id: z.string().uuid().optional().or(z.literal('')),
  catalog_item_id: z.string().uuid().optional().or(z.literal('')),
  category: z.enum(['material', 'labour', 'sub', 'equipment', 'overhead']),
  label: z.string().trim().min(1, 'Label is required').max(300),
  qty: z.coerce.number().positive('Quantity must be positive'),
  unit: z.string().trim().min(1).max(50),
  unit_cost_cents: z.coerce.number().int().min(0),
  unit_price_cents: z.coerce.number().int().min(0),
  markup_pct: z.coerce.number().min(0).max(1000),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  sort_order: z.coerce.number().int().optional().default(0),
});

function computeLineTotals(
  qty: number,
  unit_cost_cents: number,
  unit_price_cents: number,
) {
  return {
    line_cost_cents: Math.round(qty * unit_cost_cents),
    line_price_cents: Math.round(qty * unit_price_cents),
  };
}

export async function upsertCostLineAction(input: unknown): Promise<CostControlResult> {
  const parsed = costLineSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, bucket_id, catalog_item_id, notes, ...fields } = parsed.data;
  const totals = computeLineTotals(fields.qty, fields.unit_cost_cents, fields.unit_price_cents);

  const row = {
    ...fields,
    ...totals,
    bucket_id: bucket_id || null,
    catalog_item_id: catalog_item_id || null,
    notes: notes || null,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { error } = await supabase.from('project_cost_lines').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${fields.project_id}`);
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('project_cost_lines')
    .insert(row)
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to add line.' };
  revalidatePath(`/projects/${fields.project_id}`);
  return { ok: true, id: data.id as string };
}

export async function deleteCostLineAction(
  id: string,
  projectId: string,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('project_cost_lines').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

const poSchema = z.object({
  project_id: z.string().uuid(),
  vendor: z.string().trim().min(1, 'Vendor is required').max(200),
  po_number: z.string().trim().max(100).optional().or(z.literal('')),
  issued_date: z.string().optional().or(z.literal('')),
  expected_date: z.string().optional().or(z.literal('')),
  notes: z.string().trim().max(1000).optional().or(z.literal('')),
  items: z.array(
    z.object({
      label: z.string().trim().min(1).max(300),
      qty: z.coerce.number().positive(),
      unit: z.string().trim().min(1).max(50),
      unit_cost_cents: z.coerce.number().int().min(0),
      cost_line_id: z.string().uuid().optional().or(z.literal('')),
    }),
  ).min(1, 'At least one item is required'),
});

export async function createPurchaseOrderAction(input: unknown): Promise<CostControlResult> {
  const parsed = poSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { items, po_number, issued_date, expected_date, notes, ...poFields } = parsed.data;

  const itemRows = items.map((item) => ({
    ...item,
    line_total_cents: Math.round(item.qty * item.unit_cost_cents),
    cost_line_id: item.cost_line_id || null,
  }));
  const total_cents = itemRows.reduce((s, i) => s + i.line_total_cents, 0);

  const { data: po, error: poErr } = await supabase
    .from('purchase_orders')
    .insert({
      ...poFields,
      tenant_id: tenant.id,
      po_number: po_number || null,
      issued_date: issued_date || null,
      expected_date: expected_date || null,
      notes: notes || null,
      total_cents,
    })
    .select('id')
    .single();

  if (poErr || !po) return { ok: false, error: poErr?.message ?? 'Failed to create PO.' };

  const poItemRows = itemRows.map((item) => ({ ...item, po_id: po.id as string }));
  const { error: itemErr } = await supabase.from('purchase_order_items').insert(poItemRows);
  if (itemErr) return { ok: false, error: `PO created but items failed: ${itemErr.message}` };

  revalidatePath(`/projects/${poFields.project_id}`);
  return { ok: true, id: po.id as string };
}

export async function updatePurchaseOrderStatusAction(
  id: string,
  status: 'draft' | 'sent' | 'acknowledged' | 'received' | 'closed',
  projectId: string,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('purchase_orders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}

// ─── Project bills ────────────────────────────────────────────────────────────

const billSchema = z.object({
  id: z.string().uuid().optional(),
  project_id: z.string().uuid(),
  vendor: z.string().trim().min(1, 'Vendor is required').max(200),
  bill_date: z.string().min(1, 'Date is required'),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  amount_cents: z.coerce.number().int().min(1, 'Amount must be greater than 0'),
  status: z.enum(['pending', 'approved', 'paid']).optional().default('pending'),
  cost_code: z.string().trim().max(50).optional().or(z.literal('')),
});

export async function upsertBillAction(input: unknown): Promise<CostControlResult> {
  const parsed = billSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, description, cost_code, ...fields } = parsed.data;
  const row = {
    ...fields,
    description: description || null,
    cost_code: cost_code || null,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { error } = await supabase.from('project_bills').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${fields.project_id}`);
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('project_bills')
    .insert({ ...row, tenant_id: tenant.id })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create bill.' };
  revalidatePath(`/projects/${fields.project_id}`);
  return { ok: true, id: data.id as string };
}

export async function deleteBillAction(
  id: string,
  projectId: string,
): Promise<CostControlResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('project_bills').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true, id };
}
