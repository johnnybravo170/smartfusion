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

  const { data: insertedRows, error: insertErr } = await supabase
    .from('project_schedule_tasks')
    .insert(inserts)
    .select('id, planned_start_date');
  if (insertErr) return { ok: false, error: insertErr.message };

  // Auto-bootstrap finish_to_start dependency edges between consecutive
  // tasks. "Consecutive" = ordered by planned_start_date; tasks at the
  // same start (parallel tracks) chain to the same predecessor instead
  // of to each other. Drives cascade-on-edit via project_schedule_
  // dependencies.
  //
  // Skipped for blank bootstraps — they have no inserts.
  if ((insertedRows ?? []).length >= 2) {
    const sorted = [...(insertedRows as Array<{ id: string; planned_start_date: string }>)].sort(
      (a, b) => a.planned_start_date.localeCompare(b.planned_start_date),
    );
    const edges: Array<{
      project_id: string;
      tenant_id: string;
      predecessor_task_id: string;
      successor_task_id: string;
    }> = [];
    // Group tasks by start date so parallel tasks (same start) all
    // depend on the previous group rather than chaining among themselves.
    let prevGroup: Array<{ id: string; planned_start_date: string }> = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const cur = sorted[i];
      if (cur.planned_start_date === prevGroup[0].planned_start_date) {
        prevGroup.push(cur);
        continue;
      }
      // New group — link every member of prevGroup as a predecessor of
      // cur. We only edge from the FIRST member of prevGroup to keep
      // the graph sparse; the cascade math walks transitively anyway.
      edges.push({
        project_id: projectId,
        tenant_id: tenant.id,
        predecessor_task_id: prevGroup[0].id,
        successor_task_id: cur.id,
      });
      prevGroup = [cur];
    }
    if (edges.length > 0) {
      await supabase.from('project_schedule_dependencies').insert(edges);
    }
  }

  revalidatePath(`/projects/${projectId}`);
  if (project.portal_slug) revalidatePath(`/portal/${project.portal_slug}`);
  return { ok: true, tasksCreated: inserts.length };
}

/**
 * Soft-delete every active task on the project. Used by the operator's
 * "Clear schedule" action before re-bootstrapping, and as a recovery
 * lever if the bootstrap produced a wrong shape.
 */
/**
 * Cancel a pending customer schedule-update notification before the
 * cron drainer fires it. Stamps `schedule_notify_cancelled_at` so the
 * drainer's "claim atomically" guard treats this row as already-handled
 * and skips it.
 *
 * Used by the operator's "Undo" affordance on the Schedule tab when
 * the notify-on toggle is on. Idempotent — re-clicking does nothing.
 */
export async function cancelScheduleNotifyAction(
  projectId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const supabase = await createClient();

  const { error } = await supabase
    .from('projects')
    .update({ schedule_notify_cancelled_at: new Date().toISOString() })
    .eq('id', projectId)
    .is('schedule_notify_sent_at', null)
    .is('schedule_notify_cancelled_at', null)
    .not('schedule_notify_scheduled_at', 'is', null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

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
 * How long to wait before firing the customer schedule-update
 * notification. Long enough to absorb a bulk-edit session — operator
 * dragging five bars in 30 seconds emits one rollup, not five.
 *
 * Replace pattern: every edit resets schedule_notify_scheduled_at to
 * (now + delay) AND clears sent_at / cancelled_at. The cron drainer
 * picks up whatever's pending when its window opens.
 */
const SCHEDULE_NOTIFY_DELAY_MINUTES = 5;

/**
 * Cascade-forward shift: when a task's end moves later, find every
 * direct successor whose planned_start would now violate the
 * dependency (start < predecessor_end + lag_days), shift it forward
 * to satisfy the constraint, then recurse on its own successors.
 *
 * Returns the count of successor tasks that were shifted (excluding
 * the originating task itself). Idempotent — running cascade twice on
 * the same state is a no-op the second time.
 *
 * Forward-only: pulling a task earlier never pulls successors earlier.
 * GCs may have firmed up downstream dates that we shouldn't second-
 * guess.
 *
 * Implementation note: this loads ALL tasks + edges for the project
 * once, builds the graph in memory, and computes shifts in topological
 * order via a worklist. For a typical residential reno with ~20-40
 * tasks and ~40 edges this is well under 1ms even with the round-trip
 * to Postgres for the loads.
 */
async function cascadeForwardFromTask(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
  originatingTaskId: string,
): Promise<number> {
  const [{ data: tasks }, { data: edges }] = await Promise.all([
    supabase
      .from('project_schedule_tasks')
      .select('id, planned_start_date, planned_duration_days')
      .eq('project_id', projectId)
      .is('deleted_at', null),
    supabase
      .from('project_schedule_dependencies')
      .select('predecessor_task_id, successor_task_id, kind, lag_days')
      .eq('project_id', projectId),
  ]);

  if (!tasks || !edges || tasks.length === 0 || edges.length === 0) return 0;

  type T = { id: string; start: Date; duration: number };
  const byId = new Map<string, T>();
  for (const row of tasks) {
    const r = row as Record<string, unknown>;
    byId.set(r.id as string, {
      id: r.id as string,
      start: new Date(`${r.planned_start_date as string}T00:00:00Z`),
      duration: (r.planned_duration_days as number) ?? 1,
    });
  }

  // adjacency: predecessor -> [successor edges]
  type Edge = { successor: string; kind: string; lag: number };
  const adj = new Map<string, Edge[]>();
  for (const e of edges) {
    const r = e as Record<string, unknown>;
    const pred = r.predecessor_task_id as string;
    const succ = r.successor_task_id as string;
    if (!byId.has(pred) || !byId.has(succ)) continue;
    const list = adj.get(pred) ?? [];
    list.push({
      successor: succ,
      kind: (r.kind as string) ?? 'finish_to_start',
      lag: (r.lag_days as number) ?? 0,
    });
    adj.set(pred, list);
  }

  // Worklist: predecessor IDs whose downstream we need to re-check.
  // Visited set prevents infinite loops on accidental cycles (the DB
  // constraint blocks self-edges; multi-hop cycles are app-layer
  // policed but we belt-and-suspender here).
  const queue: string[] = [originatingTaskId];
  const visited = new Set<string>();
  const shifted = new Set<string>();

  const dayMs = 86_400_000;

  while (queue.length > 0) {
    const predId = queue.shift() as string;
    if (visited.has(predId)) continue;
    visited.add(predId);
    const pred = byId.get(predId);
    if (!pred) continue;
    for (const edge of adj.get(predId) ?? []) {
      const succ = byId.get(edge.successor);
      if (!succ) continue;
      // earliest start permitted by this edge:
      //   finish_to_start: predecessor.end + lag
      //   start_to_start:  predecessor.start + lag
      //   finish_to_finish: predecessor.end + lag - successor.duration
      let minStart: Date;
      if (edge.kind === 'start_to_start') {
        minStart = new Date(pred.start.getTime() + edge.lag * dayMs);
      } else if (edge.kind === 'finish_to_finish') {
        const predEnd = new Date(pred.start.getTime() + pred.duration * dayMs);
        minStart = new Date(predEnd.getTime() + edge.lag * dayMs - succ.duration * dayMs);
      } else {
        // finish_to_start (default)
        const predEnd = new Date(pred.start.getTime() + pred.duration * dayMs);
        minStart = new Date(predEnd.getTime() + edge.lag * dayMs);
      }
      if (succ.start < minStart) {
        succ.start = minStart;
        shifted.add(succ.id);
        // Successor moved → its own successors may now need to shift.
        queue.push(succ.id);
      }
    }
  }

  if (shifted.size === 0) return 0;

  // Persist the shifted set. One UPDATE per task — small N, fine for
  // the v2 baseline. Could batch via an UPSERT later if profiling shows
  // it matters.
  const updates = Array.from(shifted)
    .map((id) => byId.get(id))
    .filter((t): t is T => Boolean(t))
    .map((t) =>
      supabase
        .from('project_schedule_tasks')
        .update({
          planned_start_date: t.start.toISOString().slice(0, 10),
          updated_at: new Date().toISOString(),
        })
        .eq('id', t.id),
    );
  await Promise.all(updates);
  return shifted.size;
}

/**
 * Schedule (or replace) the project-level customer notification when
 * the tenant has the flag on AND the just-edited task is client-visible.
 * Idempotent — silent no-op when conditions aren't met.
 */
async function maybeScheduleScheduleNotify(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  projectId: string,
  taskClientVisible: boolean,
): Promise<void> {
  if (!taskClientVisible) return;

  const { data: tenantRow } = await supabase
    .from('tenants')
    .select('notify_customer_on_schedule_change')
    .eq('id', tenantId)
    .maybeSingle();
  if (!tenantRow?.notify_customer_on_schedule_change) return;

  const scheduledAt = new Date(Date.now() + SCHEDULE_NOTIFY_DELAY_MINUTES * 60_000).toISOString();
  await supabase
    .from('projects')
    .update({
      schedule_notify_scheduled_at: scheduledAt,
      schedule_notify_sent_at: null,
      schedule_notify_cancelled_at: null,
    })
    .eq('id', projectId);
}

/**
 * Window during which a fresh date/duration edit is treated as part of
 * the same "schedule edit session" — only one breadcrumb row written
 * per window per project, no matter how many bars the operator drags.
 */
const BREADCRUMB_DEDUP_MINUTES = 5;

/**
 * Append a single "Schedule updated" row to project_portal_updates so
 * the customer's portal Updates feed has a record of when the schedule
 * shifted. Independent of the SMS/email notify toggle — the feed entry
 * always lands so the customer can scroll back later. Debounced via
 * the same in-app dedup window so a flurry of drags doesn't spam the
 * feed with N identical rows.
 *
 * Uses type='system' (the catch-all) since project_portal_updates.type
 * is constrained to progress/photo/milestone/message/system.
 */
async function maybeAppendScheduleBreadcrumb(
  supabase: Awaited<ReturnType<typeof createClient>>,
  tenantId: string,
  projectId: string,
  taskClientVisible: boolean,
): Promise<void> {
  if (!taskClientVisible) return;

  const cutoff = new Date(Date.now() - BREADCRUMB_DEDUP_MINUTES * 60_000).toISOString();
  const { data: recent } = await supabase
    .from('project_portal_updates')
    .select('id')
    .eq('project_id', projectId)
    .eq('type', 'system')
    .ilike('title', 'Schedule updated%')
    .gte('created_at', cutoff)
    .limit(1)
    .maybeSingle();
  if (recent) return;

  await supabase.from('project_portal_updates').insert({
    project_id: projectId,
    tenant_id: tenantId,
    type: 'system',
    title: 'Schedule updated',
    body: 'Your contractor refined the schedule. Check the Schedule tab for the latest dates.',
    is_visible: true,
  });
}

/**
 * Update a single task. RLS gates the row to the operator's tenant; a
 * wrong-tenant taskId silently no-ops (data null, no error). Caller
 * builds the patch object — only fields present are written.
 *
 * If the patch changed `planned_start_date` or `planned_duration_days`
 * AND the task is client-visible AND the tenant has the customer-notify
 * flag on, the project's `schedule_notify_*` columns are reset so the
 * deferred-notify cron will fire after the debounce window. Re-edits
 * within the window simply reset the timer.
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
    .select('id, project_id, client_visible, projects(portal_slug)')
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: 'Task not found.' };

  const row = data as Record<string, unknown>;
  const projectId = row.project_id as string;
  const taskClientVisible = Boolean(row.client_visible);
  const portalSlug = (pickOne(row.projects)?.portal_slug as string | null | undefined) ?? null;

  // Schedule the deferred customer notification when relevant. Date or
  // duration moved → schedule shifted; visibility-only flips, status,
  // confidence, and notes don't fire a customer ping.
  if (patch.planned_start_date !== undefined || patch.planned_duration_days !== undefined) {
    // Cascade BEFORE notify/breadcrumb so the persisted state reflects
    // the post-cascade timeline by the time the cron drainer fires (or
    // the breadcrumb-dedup window opens).
    await cascadeForwardFromTask(supabase, projectId, taskId);

    await maybeScheduleScheduleNotify(supabase, tenant.id, projectId, taskClientVisible);
    // Also drop a breadcrumb in the customer's Updates feed so the
    // history is visible even when the SMS/email notify toggle is off.
    await maybeAppendScheduleBreadcrumb(supabase, tenant.id, projectId, taskClientVisible);
  }

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
