'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type CostCatalogActionResult = { ok: true; id: string } | { ok: false; error: string };

// ─── Materials catalog ────────────────────────────────────────────────────────

const materialSchema = z.object({
  id: z.string().uuid().optional(),
  category: z.enum(['material', 'labour', 'sub', 'equipment', 'overhead']),
  cost_code: z.string().trim().max(50).optional().or(z.literal('')),
  label: z.string().trim().min(1, 'Label is required').max(200),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
  unit: z.string().trim().min(1, 'Unit is required').max(50),
  unit_cost_cents: z.coerce.number().int().min(0),
  unit_price_cents: z.coerce.number().int().min(0),
  markup_pct: z.coerce.number().min(0).max(1000),
  vendor: z.string().trim().max(200).optional().or(z.literal('')),
  is_active: z.boolean().optional().default(true),
});

export async function upsertMaterialAction(input: unknown): Promise<CostCatalogActionResult> {
  const parsed = materialSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, ...fields } = parsed.data;

  const row = {
    ...fields,
    cost_code: fields.cost_code || null,
    description: fields.description || null,
    vendor: fields.vendor || null,
    updated_at: new Date().toISOString(),
  };

  if (id) {
    const { error } = await supabase.from('materials_catalog').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/settings/cost-catalog');
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('materials_catalog')
    .insert({ ...row, tenant_id: tenant.id })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create item.' };
  revalidatePath('/settings/cost-catalog');
  return { ok: true, id: data.id as string };
}

export async function deleteMaterialAction(id: string): Promise<CostCatalogActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('materials_catalog').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/cost-catalog');
  return { ok: true, id };
}

// ─── Labour rates ─────────────────────────────────────────────────────────────

const labourRateSchema = z.object({
  id: z.string().uuid().optional(),
  trade: z.string().trim().min(1, 'Trade is required').max(100),
  role: z.string().trim().min(1, 'Role is required').max(100),
  cost_per_hour_cents: z.coerce.number().int().min(0),
  bill_per_hour_cents: z.coerce.number().int().min(0),
  is_active: z.boolean().optional().default(true),
});

export async function upsertLabourRateAction(input: unknown): Promise<CostCatalogActionResult> {
  const parsed = labourRateSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, ...fields } = parsed.data;
  const row = { ...fields, updated_at: new Date().toISOString() };

  if (id) {
    const { error } = await supabase.from('labour_rates').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/settings/cost-catalog');
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('labour_rates')
    .insert({ ...row, tenant_id: tenant.id })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create rate.' };
  revalidatePath('/settings/cost-catalog');
  return { ok: true, id: data.id as string };
}

export async function deleteLabourRateAction(id: string): Promise<CostCatalogActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('labour_rates').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/cost-catalog');
  return { ok: true, id };
}
