'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type BudgetCategoryTemplateResult = { ok: true; id: string } | { ok: false; error: string };

const templateSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(200),
  section: z.enum(['interior', 'exterior', 'general']),
  categories: z.array(z.string().trim().min(1)).min(1, 'At least one category is required'),
  is_default: z.boolean().optional().default(false),
});

export async function upsertBudgetCategoryTemplateAction(
  input: unknown,
): Promise<BudgetCategoryTemplateResult> {
  const parsed = templateSchema.safeParse(input);
  if (!parsed.success) {
    const first = Object.values(parsed.error.flatten().fieldErrors)[0]?.[0];
    return { ok: false, error: first ?? 'Invalid input.' };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { id, ...row } = parsed.data;

  if (id) {
    const { error } = await supabase.from('budget_category_templates').update(row).eq('id', id);
    if (error) return { ok: false, error: error.message };
    revalidatePath('/settings/budget-category-templates');
    return { ok: true, id };
  }

  const { data, error } = await supabase
    .from('budget_category_templates')
    .insert({ ...row, tenant_id: tenant.id })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Failed to create template.' };
  revalidatePath('/settings/budget-category-templates');
  return { ok: true, id: data.id as string };
}

export async function deleteBudgetCategoryTemplateAction(
  id: string,
): Promise<BudgetCategoryTemplateResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();
  const { error } = await supabase.from('budget_category_templates').delete().eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/settings/budget-category-templates');
  return { ok: true, id };
}
