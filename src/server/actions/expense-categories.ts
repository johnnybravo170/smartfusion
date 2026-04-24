'use server';

/**
 * Expense category CRUD. Tenant-scoped via RLS.
 * Keep everything boring — categories are just labels with an optional
 * account code. No hierarchy magic, no account-type enum. The accountant
 * does the real bookkeeping elsewhere.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

type Result =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

const nameSchema = z.string().trim().min(1, 'Name is required.').max(100);
const accountCodeSchema = z.string().trim().max(40).optional().or(z.literal(''));

export async function createExpenseCategoryAction(input: {
  name: string;
  parent_id?: string | null;
  account_code?: string;
}): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = z
    .object({
      name: nameSchema,
      parent_id: z.string().uuid().optional().nullable(),
      account_code: accountCodeSchema,
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();

  // Pick a display_order that puts this row at the end of its siblings.
  const { data: siblings } = await supabase
    .from('expense_categories')
    .select('display_order')
    .eq('tenant_id', tenant.id)
    .is('parent_id', parsed.data.parent_id ?? null)
    .is('archived_at', null)
    .order('display_order', { ascending: false })
    .limit(1);
  const nextOrder = ((siblings?.[0]?.display_order as number) ?? 0) + 10;

  const { data, error } = await supabase
    .from('expense_categories')
    .insert({
      tenant_id: tenant.id,
      parent_id: parsed.data.parent_id ?? null,
      name: parsed.data.name,
      account_code: parsed.data.account_code || null,
      display_order: nextOrder,
    })
    .select('id')
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath('/settings/categories');
  return { ok: true, id: data.id as string };
}

export async function updateExpenseCategoryAction(input: {
  id: string;
  name?: string;
  account_code?: string;
}): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = z
    .object({
      id: z.string().uuid(),
      name: nameSchema.optional(),
      account_code: accountCodeSchema,
    })
    .safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Invalid input.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.name !== undefined) patch.name = parsed.data.name;
  if (parsed.data.account_code !== undefined) {
    patch.account_code = parsed.data.account_code || null;
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('expense_categories')
    .update(patch)
    .eq('id', parsed.data.id);

  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/categories');
  return { ok: true, id: parsed.data.id };
}

/**
 * Archive rather than hard-delete — historical expenses keep their FK.
 * If the category has un-archived children, archive those too so the
 * tree stays consistent.
 */
export async function archiveExpenseCategoryAction(input: { id: string }): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('expense_categories')
    .update({ archived_at: now, updated_at: now })
    .or(`id.eq.${input.id},parent_id.eq.${input.id}`);

  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/categories');
  return { ok: true, id: input.id };
}

export async function unarchiveExpenseCategoryAction(input: { id: string }): Promise<Result> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('expense_categories')
    .update({ archived_at: null, updated_at: new Date().toISOString() })
    .eq('id', input.id);

  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/categories');
  return { ok: true, id: input.id };
}

/**
 * Bulk display-order update. Front-end sends the full ordered id list
 * after a drag; we spread it across `display_order` in increments of 10
 * so single-row reorder later is cheap.
 */
export async function reorderExpenseCategoriesAction(input: {
  ids: string[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  if (!input.ids.length) return { ok: true };

  const supabase = await createClient();
  for (let i = 0; i < input.ids.length; i++) {
    const { error } = await supabase
      .from('expense_categories')
      .update({ display_order: (i + 1) * 10, updated_at: new Date().toISOString() })
      .eq('id', input.ids[i]);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath('/settings/categories');
  return { ok: true };
}

export async function setShowAccountCodesAction(input: {
  show: boolean;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('tenants')
    .update({ show_account_codes: input.show })
    .eq('id', tenant.id);

  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/categories');
  return { ok: true };
}
