'use server';

/**
 * QBO Class → HH Project mapping.
 *
 * QBO uses "Class" as the standard bookkeeper-facing job-cost tag.
 * Bills and Purchases that carried a ClassRef during import now have
 * `qbo_class_name` denormalized onto the parent record (`bills` and
 * `expenses`); this module lets the user pick which HH project each
 * distinct class maps to, then backfills `project_id` in bulk.
 *
 * No mapping cache — re-running an import just re-applies the user's
 * picks by re-binding records via qbo_class_name. If a user wants to
 * remap, they re-visit this page and pick a different project.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export type ClassMappingSummary = {
  qbo_class_name: string;
  bill_count: number;
  expense_count: number;
  total_cents: number;
  /** Current project_id most rows are tagged with (if any). */
  current_project_id: string | null;
  current_project_name: string | null;
};

export type ListClassMappingsResult =
  | { ok: true; classes: ClassMappingSummary[]; projects: Array<{ id: string; name: string }> }
  | { ok: false; error: string };

export async function listClassMappingsAction(): Promise<ListClassMappingsResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = createAdminClient();

  // Pull every bill + expense with a non-null qbo_class_name. Tenants
  // with hundreds of records per class still fit in one page (rare to
  // exceed 10k rows even on big imports).
  const [billRes, expenseRes, projectRes] = await Promise.all([
    supabase
      .from('bills')
      .select('qbo_class_name, project_id, total_cents')
      .eq('tenant_id', tenant.id)
      .not('qbo_class_name', 'is', null),
    supabase
      .from('project_costs')
      .select('qbo_class_name, project_id, amount_cents')
      .eq('tenant_id', tenant.id)
      .eq('source_type', 'receipt')
      .not('qbo_class_name', 'is', null),
    supabase
      .from('projects')
      .select('id, name')
      .eq('tenant_id', tenant.id)
      .is('deleted_at', null)
      .order('name', { ascending: true })
      .limit(500),
  ]);

  if (billRes.error) return { ok: false, error: `Failed to load bills: ${billRes.error.message}` };
  if (expenseRes.error)
    return { ok: false, error: `Failed to load expenses: ${expenseRes.error.message}` };
  if (projectRes.error)
    return { ok: false, error: `Failed to load projects: ${projectRes.error.message}` };

  const projects = ((projectRes.data ?? []) as Array<{ id: string; name: string }>).map((p) => ({
    id: p.id,
    name: p.name,
  }));
  const projectNameById = new Map(projects.map((p) => [p.id, p.name] as const));

  type Agg = {
    bill_count: number;
    expense_count: number;
    total_cents: number;
    project_counts: Map<string, number>;
  };
  const agg = new Map<string, Agg>();
  function bump(className: string): Agg {
    let a = agg.get(className);
    if (!a) {
      a = { bill_count: 0, expense_count: 0, total_cents: 0, project_counts: new Map() };
      agg.set(className, a);
    }
    return a;
  }

  for (const row of (billRes.data ?? []) as Array<{
    qbo_class_name: string | null;
    project_id: string | null;
    total_cents: number;
  }>) {
    if (!row.qbo_class_name) continue;
    const a = bump(row.qbo_class_name);
    a.bill_count += 1;
    a.total_cents += row.total_cents ?? 0;
    if (row.project_id)
      a.project_counts.set(row.project_id, (a.project_counts.get(row.project_id) ?? 0) + 1);
  }
  for (const row of (expenseRes.data ?? []) as Array<{
    qbo_class_name: string | null;
    project_id: string | null;
    amount_cents: number;
  }>) {
    if (!row.qbo_class_name) continue;
    const a = bump(row.qbo_class_name);
    a.expense_count += 1;
    a.total_cents += row.amount_cents ?? 0;
    if (row.project_id)
      a.project_counts.set(row.project_id, (a.project_counts.get(row.project_id) ?? 0) + 1);
  }

  const classes: ClassMappingSummary[] = [];
  for (const [name, a] of agg.entries()) {
    let topProjectId: string | null = null;
    let topCount = 0;
    for (const [pid, count] of a.project_counts.entries()) {
      if (count > topCount) {
        topProjectId = pid;
        topCount = count;
      }
    }
    classes.push({
      qbo_class_name: name,
      bill_count: a.bill_count,
      expense_count: a.expense_count,
      total_cents: a.total_cents,
      current_project_id: topProjectId,
      current_project_name: topProjectId ? (projectNameById.get(topProjectId) ?? null) : null,
    });
  }
  classes.sort((a, b) => b.total_cents - a.total_cents);

  return { ok: true, classes, projects };
}

const mapSchema = z.object({
  qboClassName: z.string().min(1).max(200),
  projectId: z.string().uuid().nullable(),
  /** When true, only update rows where project_id IS NULL — preserves manual edits. */
  preserveExisting: z.boolean().default(true),
});

export type ApplyClassMappingInput = z.input<typeof mapSchema>;
export type ApplyClassMappingResult =
  | { ok: true; bills_updated: number; expenses_updated: number }
  | { ok: false; error: string };

/**
 * Update every bill + expense with the given qbo_class_name to point
 * at `projectId`. When `preserveExisting` is true (the default), rows
 * already assigned to a different project are left alone — useful
 * when the user has manually tagged some records and only wants to
 * fill in the gaps.
 *
 * Pass `projectId: null` to clear the mapping.
 */
export async function applyClassMappingAction(
  input: ApplyClassMappingInput,
): Promise<ApplyClassMappingResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = mapSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const { qboClassName, projectId, preserveExisting } = parsed.data;

  // Validate project belongs to tenant.
  if (projectId) {
    const supabase = createAdminClient();
    const { data: proj } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (!proj) return { ok: false, error: 'Selected project does not belong to this account.' };
  }

  const supabase = createAdminClient();
  const now = new Date().toISOString();

  let billsQuery = supabase
    .from('bills')
    .update({ project_id: projectId, updated_at: now }, { count: 'exact' })
    .eq('tenant_id', tenant.id)
    .eq('qbo_class_name', qboClassName);
  if (preserveExisting) {
    billsQuery = billsQuery.is('project_id', null);
  }
  const billsRes = await billsQuery;
  if (billsRes.error) return { ok: false, error: `Bills update failed: ${billsRes.error.message}` };

  let expensesQuery = supabase
    .from('project_costs')
    .update({ project_id: projectId, updated_at: now }, { count: 'exact' })
    .eq('tenant_id', tenant.id)
    .eq('source_type', 'receipt')
    .eq('qbo_class_name', qboClassName);
  if (preserveExisting) {
    expensesQuery = expensesQuery.is('project_id', null);
  }
  const expensesRes = await expensesQuery;
  if (expensesRes.error)
    return { ok: false, error: `Expenses update failed: ${expensesRes.error.message}` };

  revalidatePath('/settings/qbo-class-mapping');
  return {
    ok: true,
    bills_updated: billsRes.count ?? 0,
    expenses_updated: expensesRes.count ?? 0,
  };
}
