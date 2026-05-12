'use server';

/**
 * Server actions for expense recurring rules.
 *
 * Create a rule by cloning an existing expense's fields — operator
 * picks a day of month and we copy vendor/amount/category/tax/etc. at
 * that moment. Subsequent changes to the source expense don't flow
 * through to the rule; the rule is its own standalone record.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type RecurringResult = { ok: true; id: string } | { ok: false; error: string };

const createSchema = z.object({
  source_expense_id: z.string().uuid(),
  day_of_month: z.coerce.number().int().min(1).max(28),
});

/**
 * Convert an existing overhead expense into a recurring rule. Clones
 * the identifying fields and sets next_run_at to the next occurrence
 * of day_of_month (today or next month, whichever is later).
 */
export async function createRecurringFromExpenseAction(input: {
  source_expense_id: string;
  day_of_month: number;
}): Promise<RecurringResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'Invalid input.' };

  const admin = createAdminClient();
  // Source expense for the recurring rule template — receipts only.
  const { data: source } = await admin
    .from('project_costs')
    .select('category_id, vendor, description, amount_cents, gst_cents, tenant_id, project_id')
    .eq('id', parsed.data.source_expense_id)
    .eq('source_type', 'receipt')
    .single();
  if (!source || source.tenant_id !== tenant.id) {
    return { ok: false, error: 'Source expense not found.' };
  }
  if (source.project_id !== null) {
    return {
      ok: false,
      error: 'Recurring is for overhead expenses only. Project costs aren\u2019t recurring.',
    };
  }

  // Compute next_run_at: if today.day <= day_of_month, use this month's
  // occurrence; else jump to next month.
  const today = new Date();
  const dom = parsed.data.day_of_month;
  const thisMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), dom));
  const nextRun =
    today.getUTCDate() > dom
      ? new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, dom))
      : thisMonth;
  const nextRunIso = nextRun.toISOString().slice(0, 10);

  const { data, error } = await admin
    .from('expense_recurring_rules')
    .insert({
      tenant_id: tenant.id,
      created_by: tenant.member.id,
      category_id: source.category_id,
      vendor: source.vendor,
      description: source.description,
      amount_cents: source.amount_cents,
      tax_cents: (source as { gst_cents?: number }).gst_cents ?? 0,
      frequency: 'monthly',
      day_of_month: dom,
      next_run_at: nextRunIso,
      active: true,
    })
    .select('id')
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath('/expenses');
  return { ok: true, id: data.id as string };
}

export async function cancelRecurringRuleAction(input: {
  id: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const admin = createAdminClient();
  const { error } = await admin
    .from('expense_recurring_rules')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('id', input.id)
    .eq('tenant_id', tenant.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/expenses');
  return { ok: true };
}
