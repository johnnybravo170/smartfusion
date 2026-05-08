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
import { generateAiBootstrap } from '@/lib/ai/schedule-bootstrap';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type BootstrapSource =
  | { kind: 'template'; projectTypeTemplateSlug: string }
  | { kind: 'budget' }
  | { kind: 'blank' };

export type BootstrapResult = { ok: true; tasksCreated: number } | { ok: false; error: string };

type ResolvedTrade = {
  /** Null when bootstrapping from an unmapped budget category. */
  trade_template_id: string | null;
  name: string;
  duration_days: number;
  sequence_position: number;
  typical_phase: string | null;
  budget_category_id: string | null;
};

/**
 * Default duration (days) for tasks bootstrapped from a budget category
 * that has no trade-template mapping. Long enough to be visible on the
 * Gantt; the GC will firm it up later. Pulled out as a const so v1's
 * "add custom task" UI can reuse the same default.
 */
const UNMAPPED_TASK_DURATION_DAYS = 3;
/** Mid-timeline default for unmapped tasks so mapped trades sort first. */
const UNMAPPED_SEQUENCE_POSITION = 50;

type LaidOutTask = {
  trade: ResolvedTrade;
  planned_start_date: string;
  display_order: number;
};

/**
 * Serial layout — each task starts where the previous one ended.
 * Used as the static fallback when AI bootstrap isn't engaged or fails.
 */
function layoutTasksSerial(trades: ResolvedTrade[], startDate: Date): LaidOutTask[] {
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

/**
 * Parallel-aware layout — each task uses the AI-provided offset from
 * project start, and AI-provided duration overrides the trade default.
 * Multiple tasks may share an offset (true parallel tracks).
 */
function layoutTasksFromOffsets(
  trades: ResolvedTrade[],
  startDate: Date,
  offsetMap: Map<string, { offset: number; duration: number }>,
): LaidOutTask[] {
  const enriched = trades.map((trade) => {
    const ai = trade.budget_category_id ? offsetMap.get(trade.budget_category_id) : undefined;
    const duration = ai?.duration ?? trade.duration_days;
    const offset = ai?.offset ?? 0;
    return { trade: { ...trade, duration_days: duration }, offset };
  });
  // Sort by offset; trade's canonical sequence_position breaks ties so
  // parallel-track rows render in a sensible top-to-bottom order.
  enriched.sort(
    (a, b) => a.offset - b.offset || a.trade.sequence_position - b.trade.sequence_position,
  );
  return enriched.map(({ trade, offset }, idx) => {
    const start = new Date(startDate);
    start.setUTCDate(start.getUTCDate() + offset);
    return {
      trade,
      planned_start_date: start.toISOString().slice(0, 10),
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
    .select('id, name, description, start_date, portal_slug')
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
          ? 'This project has no budget categories yet. Add some on the Budget tab, or pick a project-type template instead.'
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

  // Hybrid AI bootstrap: when source=budget AND any category didn't map
  // to a canonical trade, the static sequence_position table puts those
  // unmapped categories mid-timeline in arbitrary order. Engage AI to do
  // a smarter ordering with realistic durations and parallel tracks.
  // Static path stays in charge for fully-mapped budgets and for
  // template / blank sources.
  let aiOffsets: Map<string, { offset: number; duration: number }> | null = null;
  if (source.kind === 'budget' && trades.some((t) => t.trade_template_id === null)) {
    // Pull estimate_cents + display_order for the AI prompt — gives the
    // model scope context (a $20k Plumbing line is a bigger task than
    // a $1k one).
    const { data: catMeta } = await supabase
      .from('project_budget_categories')
      .select('id, estimate_cents, display_order')
      .eq('project_id', projectId);
    const metaById = new Map<string, { estimate_cents: number; display_order: number }>();
    for (const row of catMeta ?? []) {
      const r = row as Record<string, unknown>;
      metaById.set(r.id as string, {
        estimate_cents: (r.estimate_cents as number | null) ?? 0,
        display_order: (r.display_order as number | null) ?? 0,
      });
    }
    const aiInputCategories = trades
      .filter((t): t is ResolvedTrade & { budget_category_id: string } =>
        Boolean(t.budget_category_id),
      )
      .map((t) => {
        const meta = metaById.get(t.budget_category_id);
        return {
          id: t.budget_category_id,
          name: t.name,
          estimateCents: meta?.estimate_cents ?? 0,
          displayOrder: meta?.display_order ?? 0,
          tradeName: t.trade_template_id ? t.name : null,
        };
      });
    const ai = await generateAiBootstrap({
      projectName: (project.name as string) ?? 'Project',
      projectDescription: (project.description as string | null) ?? null,
      categories: aiInputCategories,
    });
    if (ai) {
      aiOffsets = new Map();
      for (const t of ai) {
        aiOffsets.set(t.budget_category_id, {
          offset: t.start_offset_days,
          duration: t.duration_days,
        });
      }
    }
  }

  const laidOut = aiOffsets
    ? layoutTasksFromOffsets(trades, startDate, aiOffsets)
    : layoutTasksSerial(trades, startDate);

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

// ---------------------------------------------------------------------------
// v1: edit / delete / create individual tasks
// ---------------------------------------------------------------------------

export type TaskMutationResult = { ok: true; taskId: string } | { ok: false; error: string };

export type ScheduleTaskPatch = {
  name?: string;
  planned_start_date?: string;
  planned_duration_days?: number;
  status?: 'planned' | 'scheduled' | 'in_progress' | 'done';
  confidence?: 'rough' | 'firm';
  client_visible?: boolean;
  notes?: string | null;
};

/**
 * Update a single task. RLS gates the row to the operator's tenant; a
 * wrong-tenant taskId silently no-ops (data null, no error). Caller
 * builds the patch object — only fields present are written.
 */
export async function updateScheduleTaskAction(
  taskId: string,
  patch: ScheduleTaskPatch,
): Promise<TaskMutationResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('project_schedule_tasks')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', taskId)
    .is('deleted_at', null)
    .select('id, project_id, projects(portal_slug)')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Task not found.' };

  const projectId = (data as Record<string, unknown>).project_id as string;
  const portalSlug =
    (pickOne((data as Record<string, unknown>).projects)?.portal_slug as
      | string
      | null
      | undefined) ?? null;
  revalidatePath(`/projects/${projectId}`);
  if (portalSlug) revalidatePath(`/portal/${portalSlug}`);
  return { ok: true, taskId };
}

/**
 * Soft-delete a single task. The row stays in the table for audit and
 * customer-portal history queries; the active-list reads filter it out.
 */
export async function deleteScheduleTaskAction(taskId: string): Promise<TaskMutationResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('project_schedule_tasks')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', taskId)
    .is('deleted_at', null)
    .select('id, project_id, projects(portal_slug)')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Task not found.' };

  const projectId = (data as Record<string, unknown>).project_id as string;
  const portalSlug =
    (pickOne((data as Record<string, unknown>).projects)?.portal_slug as
      | string
      | null
      | undefined) ?? null;
  revalidatePath(`/projects/${projectId}`);
  if (portalSlug) revalidatePath(`/portal/${portalSlug}`);
  return { ok: true, taskId };
}

export type CreateScheduleTaskInput = {
  name: string;
  planned_start_date: string;
  planned_duration_days: number;
  client_visible?: boolean;
  notes?: string | null;
};

/**
 * Create a new custom task on a project. Always lands at the end of
 * display_order (operator can reorder later). trade_template_id is
 * always null — these are GC-authored, not template-derived.
 */
export async function createScheduleTaskAction(
  projectId: string,
  input: CreateScheduleTaskInput,
): Promise<TaskMutationResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  const { data: project } = await supabase
    .from('projects')
    .select('id, portal_slug')
    .eq('id', projectId)
    .single();
  if (!project) return { ok: false, error: 'Project not found.' };

  // Land at end of display_order (sparse +1).
  const { data: maxRow } = await supabase
    .from('project_schedule_tasks')
    .select('display_order')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((maxRow as { display_order?: number } | null)?.display_order ?? -1) + 1;

  const { data, error } = await supabase
    .from('project_schedule_tasks')
    .insert({
      tenant_id: tenant.id,
      project_id: projectId,
      name: input.name,
      planned_start_date: input.planned_start_date,
      planned_duration_days: input.planned_duration_days,
      status: 'planned',
      confidence: 'rough',
      client_visible: input.client_visible ?? true,
      display_order: nextOrder,
      notes: input.notes ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Insert failed.' };

  revalidatePath(`/projects/${projectId}`);
  if (project.portal_slug) revalidatePath(`/portal/${project.portal_slug}`);
  return { ok: true, taskId: (data as Record<string, unknown>).id as string };
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

  // source.kind === 'budget' — include EVERY budget category, mapped or
  // not. Mapped categories pull duration / sequence / phase rollup from
  // the trade template (good intelligence). Unmapped ones get a sensible
  // default so the GC's full budget shows up as draft tasks they can
  // refine — better than only showing the small subset that happen to
  // match a trade name exactly.
  const { data: rows } = await supabase
    .from('project_budget_categories')
    .select(
      'id, name, display_order, trade_template_id, trade_templates(id, name, default_duration_days, sequence_position, typical_phase)',
    )
    .eq('project_id', projectId);

  return (rows ?? []).map((r): ResolvedTrade => {
    const row = r as Record<string, unknown>;
    const trade = pickOne(row.trade_templates);
    const budgetCategoryId = row.id as string;
    const budgetName = (row.name as string) ?? 'Untitled';
    const displayOrder = (row.display_order as number | null) ?? 0;

    if (trade) {
      return {
        trade_template_id: trade.id as string,
        name: trade.name as string,
        duration_days: trade.default_duration_days as number,
        sequence_position: trade.sequence_position as number,
        typical_phase: (trade.typical_phase as string | null) ?? null,
        budget_category_id: budgetCategoryId,
      };
    }
    return {
      trade_template_id: null,
      name: budgetName,
      duration_days: UNMAPPED_TASK_DURATION_DAYS,
      // Bias unmapped tasks toward the middle of the timeline, then break
      // ties by their position in the budget so the order isn't random.
      sequence_position: UNMAPPED_SEQUENCE_POSITION + Math.min(displayOrder, 49),
      typical_phase: null,
      budget_category_id: budgetCategoryId,
    };
  });
}
