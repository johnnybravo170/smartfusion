'use server';

/**
 * Server actions for the per-project Gantt schedule.
 *
 * v0 surface area: bootstrap a draft schedule from one of three sources
 * (project-type template / budget categories / blank), and clear an
 * existing schedule (soft-delete) so the GC can re-bootstrap.
 *
 * All mutations run through the RLS-aware server client; tenant
 * isolation is enforced by `project_schedule_tasks` policies (no
 * app-side tenant filtering). The `tenant_id` column is auto-stamped
 * by a BEFORE INSERT trigger from the linked project — server actions
 * still pass it explicitly so the WITH CHECK clause sees a value
 * matching `current_tenant_id()`.
 *
 * Drag-to-reschedule, click-to-edit, and the GC-level notify toggle
 * land in v1 (kanban 6f110321).
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type BootstrapSource =
  | { kind: 'template'; projectTypeTemplateSlug: string }
  | { kind: 'budget' }
  | { kind: 'blank' };

export type BootstrapResult = { ok: true; tasksCreated: number } | { ok: false; error: string };

type ResolvedTrade = {
  trade_template_id: string;
  name: string;
  duration_days: number;
  sequence_position: number;
  typical_phase: string | null;
  budget_category_id: string | null;
};

/**
 * Lay out a sequenced list of tasks starting from `startDate`. Each task
 * starts where the previous one ended — no gaps, no overlap. Pure date
 * math, extracted so the v1 reschedule logic can reuse it.
 */
function layoutTasks(
  trades: ResolvedTrade[],
  startDate: Date,
): Array<{ trade: ResolvedTrade; planned_start_date: string; display_order: number }> {
  let cursor = 0;
  return trades.map((trade, idx) => {
    const taskDate = new Date(startDate);
    taskDate.setUTCDate(taskDate.getUTCDate() + cursor);
    cursor += trade.duration_days;
    return {
      trade,
      planned_start_date: taskDate.toISOString().slice(0, 10),
      display_order: idx,
    };
  });
}

export async function bootstrapProjectScheduleAction(
  projectId: string,
  source: BootstrapSource,
): Promise<BootstrapResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  // RLS gates project visibility — a wrong-tenant lookup returns null.
  const { data: project, error: projErr } = await supabase
    .from('projects')
    .select('id, start_date, portal_slug')
    .eq('id', projectId)
    .single();
  if (projErr || !project) return { ok: false, error: 'Project not found.' };

  // Idempotency: refuse if any active task exists. GC must clear first.
  const { count: existingCount } = await supabase
    .from('project_schedule_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .is('deleted_at', null);
  if ((existingCount ?? 0) > 0) {
    return {
      ok: false,
      error: 'Schedule already exists. Clear it before re-bootstrapping.',
    };
  }

  if (source.kind === 'blank') {
    return { ok: true, tasksCreated: 0 };
  }

  const trades = await resolveTrades(supabase, projectId, source);
  if (trades.length === 0) {
    return {
      ok: false,
      error:
        source.kind === 'budget'
          ? 'No budget categories are mapped to trades yet. Pick a project-type template instead, or map your budget categories first.'
          : 'Template has no trades configured.',
    };
  }

  // Stable sort: sequence_position primary, name as tiebreaker.
  trades.sort((a, b) => a.sequence_position - b.sequence_position || a.name.localeCompare(b.name));

  // Phase-name → phase_id lookup for optional rollup. Lower-cased trim.
  const { data: phaseRows } = await supabase
    .from('project_phases')
    .select('id, name')
    .eq('project_id', projectId);
  const phaseByName = new Map<string, string>();
  for (const ph of phaseRows ?? []) {
    phaseByName.set((ph.name as string).trim().toLowerCase(), ph.id as string);
  }

  // Project start_date drives the timeline anchor. Fall back to today
  // when null (operators can adjust later by dragging or by setting
  // project.start_date).
  const startDateStr =
    (project.start_date as string | null) ?? new Date().toISOString().slice(0, 10);
  const startDate = new Date(`${startDateStr}T00:00:00Z`);

  const laidOut = layoutTasks(trades, startDate);

  const inserts = laidOut.map(({ trade, planned_start_date, display_order }) => ({
    tenant_id: tenant.id,
    project_id: projectId,
    name: trade.name,
    trade_template_id: trade.trade_template_id,
    budget_category_id: trade.budget_category_id,
    phase_id: trade.typical_phase
      ? (phaseByName.get(trade.typical_phase.trim().toLowerCase()) ?? null)
      : null,
    planned_start_date,
    planned_duration_days: trade.duration_days,
    status: 'planned' as const,
    confidence: 'rough' as const,
    client_visible: true,
    display_order,
  }));

  const { error: insertErr } = await supabase.from('project_schedule_tasks').insert(inserts);
  if (insertErr) return { ok: false, error: insertErr.message };

  revalidatePath(`/projects/${projectId}`);
  if (project.portal_slug) revalidatePath(`/portal/${project.portal_slug}`);
  return { ok: true, tasksCreated: inserts.length };
}

/**
 * Soft-delete every active task on the project. Used by the operator's
 * "Clear schedule" action before re-bootstrapping, and as a recovery
 * lever if the bootstrap produced a wrong shape.
 */
export async function clearProjectScheduleAction(
  projectId: string,
): Promise<{ ok: true; tasksCleared: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, portal_slug')
    .eq('id', projectId)
    .single();
  if (!project) return { ok: false, error: 'Project not found.' };

  const { data, error } = await supabase
    .from('project_schedule_tasks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .select('id');
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  if (project.portal_slug) revalidatePath(`/portal/${project.portal_slug}`);
  return { ok: true, tasksCleared: (data ?? []).length };
}

/**
 * Resolve the trade list for a non-blank bootstrap source. Pure-ish
 * (just hits the DB twice in the worst case) — extracted so the call
 * site reads as a single line.
 */
/**
 * Supabase types embedded n→1 relations as arrays even when they're
 * single. Pick the first element if it came back as an array, return as-
 * is if it's already an object, or null if missing.
 */
function pickOne(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return (value[0] as Record<string, unknown>) ?? null;
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  return null;
}

async function resolveTrades(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
  source: Exclude<BootstrapSource, { kind: 'blank' }>,
): Promise<ResolvedTrade[]> {
  if (source.kind === 'template') {
    const { data: template } = await supabase
      .from('project_type_templates')
      .select('id')
      .eq('slug', source.projectTypeTemplateSlug)
      .maybeSingle();
    if (!template) return [];

    const { data: rows } = await supabase
      .from('project_type_template_trades')
      .select(
        'duration_override_days, sequence_override, trade_templates(id, name, default_duration_days, sequence_position, typical_phase)',
      )
      .eq('project_type_template_id', template.id);

    return (rows ?? [])
      .map((r): ResolvedTrade | null => {
        const t = pickOne((r as Record<string, unknown>).trade_templates);
        if (!t) return null;
        return {
          trade_template_id: t.id as string,
          name: t.name as string,
          duration_days:
            ((r as Record<string, unknown>).duration_override_days as number | null) ??
            (t.default_duration_days as number),
          sequence_position:
            ((r as Record<string, unknown>).sequence_override as number | null) ??
            (t.sequence_position as number),
          typical_phase: (t.typical_phase as string | null) ?? null,
          budget_category_id: null,
        };
      })
      .filter((t): t is ResolvedTrade => t !== null);
  }

  // source.kind === 'budget'
  const { data: rows } = await supabase
    .from('project_budget_categories')
    .select(
      'id, trade_template_id, trade_templates(id, name, default_duration_days, sequence_position, typical_phase)',
    )
    .eq('project_id', projectId)
    .not('trade_template_id', 'is', null);

  return (rows ?? [])
    .map((r): ResolvedTrade | null => {
      const t = pickOne((r as Record<string, unknown>).trade_templates);
      if (!t) return null;
      return {
        trade_template_id: t.id as string,
        name: t.name as string,
        duration_days: t.default_duration_days as number,
        sequence_position: t.sequence_position as number,
        typical_phase: (t.typical_phase as string | null) ?? null,
        budget_category_id: (r as Record<string, unknown>).id as string,
      };
    })
    .filter((t): t is ResolvedTrade => t !== null);
}
