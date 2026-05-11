'use server';

/**
 * Server actions for the Pricebook (`catalog_items`).
 *
 * PR #1 of the Pricebook epic. The UI in `/settings/pricebook` lands in PR #2;
 * for now these actions are reachable from server-internal code (import worker)
 * and unit tests.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type CatalogItemActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const PRICING_MODELS = ['fixed', 'per_unit', 'hourly', 'time_and_materials'] as const;
const CATEGORIES = ['labor', 'materials', 'service', 'inventory', 'other'] as const;

const upsertSchema = z
  .object({
    id: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Name is required.').max(200),
    description: z.string().trim().max(2000).nullable().optional(),
    sku: z.string().trim().max(100).nullable().optional(),
    pricingModel: z.enum(PRICING_MODELS),
    unitLabel: z.string().trim().max(50).nullable().optional(),
    unitPriceCents: z.number().int().min(0).nullable().optional(),
    minChargeCents: z.number().int().min(0).nullable().optional(),
    isTaxable: z.boolean().default(true),
    category: z.enum(CATEGORIES).nullable().optional(),
    surfaceType: z.string().trim().max(100).nullable().optional(),
    isActive: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    // Mirror the DB CHECK constraint: time_and_materials = no price; everything else = price required.
    if (val.pricingModel === 'time_and_materials' && val.unitPriceCents != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPriceCents'],
        message: 'Time-and-materials items must not have a unit price.',
      });
    }
    if (val.pricingModel !== 'time_and_materials' && val.unitPriceCents == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unitPriceCents'],
        message: 'Unit price is required for this pricing model.',
      });
    }
  });

export type UpsertCatalogItemInput = z.input<typeof upsertSchema>;

function flattenFieldErrors(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_';
    const bucket = out[key] ?? [];
    bucket.push(issue.message);
    out[key] = bucket;
  }
  return out;
}

export async function upsertCatalogItemAction(
  input: UpsertCatalogItemInput,
): Promise<CatalogItemActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const parsed = upsertSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid input.', fieldErrors: flattenFieldErrors(parsed.error) };
  }
  const v = parsed.data;
  const now = new Date().toISOString();

  const supabase = await createClient();

  const writeRow = {
    name: v.name,
    description: v.description ?? null,
    sku: v.sku ?? null,
    pricing_model: v.pricingModel,
    unit_label: v.unitLabel ?? null,
    unit_price_cents: v.unitPriceCents ?? null,
    min_charge_cents: v.minChargeCents ?? null,
    is_taxable: v.isTaxable,
    category: v.category ?? null,
    surface_type: v.surfaceType ?? null,
    is_active: v.isActive,
    updated_at: now,
  };

  if (v.id) {
    const { error } = await supabase.from('catalog_items').update(writeRow).eq('id', v.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/settings/pricebook');
    return { ok: true, id: v.id };
  }

  const { data, error } = await supabase
    .from('catalog_items')
    .insert({ ...writeRow, tenant_id: tenant.id })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create catalog item.' };
  }
  revalidatePath('/settings/pricebook');
  return { ok: true, id: data.id as string };
}

export async function deactivateCatalogItemAction(id: string): Promise<CatalogItemActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from('catalog_items')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/pricebook');
  return { ok: true, id };
}

export async function activateCatalogItemAction(id: string): Promise<CatalogItemActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from('catalog_items')
    .update({ is_active: true, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/pricebook');
  return { ok: true, id };
}

/**
 * Insert the starter pricebook for the tenant's vertical (HVAC, plumbing,
 * GC, etc.). Idempotent — items whose name already exists for the tenant
 * are skipped. Result includes how many were created vs skipped so the UI
 * can confirm "Added 12 items, skipped 3 you already had."
 */
export type SeedPricebookResult =
  | { ok: true; created: number; skipped: number; vertical: string }
  | { ok: false; error: string };

export async function seedPricebookFromVerticalAction(): Promise<SeedPricebookResult> {
  const { getPricebookSeeds } = await import('@/lib/verticals/pricebook-seeds');

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const vertical = tenant.vertical ?? null;
  const seeds = getPricebookSeeds(vertical);
  if (seeds.length === 0) {
    return {
      ok: false,
      error: `No starter pricebook for vertical "${vertical ?? 'unknown'}".`,
    };
  }

  const supabase = await createClient();

  // Pull existing names once to dedupe in memory. Cheaper than per-row
  // ON CONFLICT for the small N we expect (≤20 starter items per tenant).
  const { data: existing, error: listErr } = await supabase
    .from('catalog_items')
    .select('name')
    .eq('tenant_id', tenant.id);

  if (listErr) return { ok: false, error: listErr.message };

  const existingNames = new Set(
    (existing ?? []).map((r) => ((r.name as string) ?? '').trim().toLowerCase()),
  );

  const rowsToInsert = seeds
    .filter((s) => !existingNames.has(s.name.trim().toLowerCase()))
    .map((s) => ({
      tenant_id: tenant.id,
      name: s.name,
      description: s.description ?? null,
      pricing_model: s.pricingModel,
      unit_label: s.unitLabel ?? null,
      unit_price_cents: s.unitPriceCents ?? null,
      min_charge_cents: s.minChargeCents ?? null,
      is_taxable: s.isTaxable ?? true,
      category: s.category ?? null,
      surface_type: s.surfaceType ?? null,
      is_active: true,
    }));

  if (rowsToInsert.length === 0) {
    revalidatePath('/settings/pricebook');
    return { ok: true, created: 0, skipped: seeds.length, vertical: vertical ?? '' };
  }

  const { error: insertErr } = await supabase.from('catalog_items').insert(rowsToInsert);
  if (insertErr) return { ok: false, error: insertErr.message };

  revalidatePath('/settings/pricebook');
  return {
    ok: true,
    created: rowsToInsert.length,
    skipped: seeds.length - rowsToInsert.length,
    vertical: vertical ?? '',
  };
}
