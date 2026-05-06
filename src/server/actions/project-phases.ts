'use server';

/**
 * Server actions for project phases.
 *
 * Phases are the homeowner-facing milestone roadmap. The operator
 * advances / regresses / edits the rail from the Portal tab on the
 * project detail page. Mutations run through the RLS-aware server
 * client; tenant isolation is enforced by the project_phases RLS
 * policies (no app-side tenant filtering).
 *
 * Homeowner notification on advance is DEFERRED — see
 * PORTAL_PHASES_PLAN.md Phase 2. Advance schedules a notify; a cron
 * drainer (/api/cron/portal-phase-notify) sends it after a delay,
 * which can be cancelled (Undo) or replaced (advance again before the
 * timer fires).
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type PhaseActionResult = { ok: true } | { ok: false; error: string };

export type AdvancePhaseResult =
  | { ok: true; notifyScheduledAt: string | null; nextPhaseName: string | null }
  | { ok: false; error: string };

/**
 * How long to wait before firing the homeowner notification, in minutes.
 * Tuned by PORTAL_PHASES_PLAN.md §"Notify delay duration": short enough
 * that the homeowner hears about real milestones promptly, long enough
 * to absorb rapid-fire catch-up clicks and give the operator an Undo
 * window.
 */
const NOTIFY_DELAY_MINUTES = 5;

/**
 * Cancel any pending (scheduled, not sent, not cancelled) homeowner
 * notification on a project. Used both when the operator hits Undo on a
 * specific phase and when an advance / regress invalidates the prior
 * pending notify (the homeowner should hear about the latest state, not
 * an obsolete one).
 */
async function cancelPendingNotificationsForProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
): Promise<void> {
  await supabase
    .from('project_phases')
    .update({ notify_cancelled_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .is('notify_sent_at', null)
    .is('notify_cancelled_at', null)
    .not('notify_scheduled_at', 'is', null);
}

async function schedulePhaseNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  phaseId: string,
): Promise<string> {
  const scheduledAt = new Date(Date.now() + NOTIFY_DELAY_MINUTES * 60_000).toISOString();
  await supabase
    .from('project_phases')
    .update({
      notify_scheduled_at: scheduledAt,
      notify_sent_at: null,
      notify_cancelled_at: null,
    })
    .eq('id', phaseId);
  return scheduledAt;
}

/**
 * Mark the current `in_progress` phase complete and the next `upcoming`
 * phase `in_progress`. No-op (returns ok) if the project is already on
 * its last phase.
 */
export async function advancePhaseAction(projectId: string): Promise<AdvancePhaseResult> {
  const supabase = await createClient();

  const { data: phases, error: listErr } = await supabase
    .from('project_phases')
    .select('id, name, status, display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });

  if (listErr || !phases) return { ok: false, error: listErr?.message ?? 'Could not load phases.' };

  // Whenever we mutate phase state, any prior pending notification on
  // this project becomes obsolete — the homeowner should hear about the
  // latest state, not a stale earlier one. Cancel first; new schedule
  // (if any) follows below.
  await cancelPendingNotificationsForProject(supabase, projectId);

  const currentIdx = phases.findIndex((p) => p.status === 'in_progress');

  // No current phase yet — start the first upcoming one.
  if (currentIdx === -1) {
    const firstUpcoming = phases.find((p) => p.status === 'upcoming');
    if (!firstUpcoming) return { ok: true, notifyScheduledAt: null, nextPhaseName: null };
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', firstUpcoming.id);
    if (error) return { ok: false, error: error.message };
    const scheduledAt = await schedulePhaseNotification(supabase, firstUpcoming.id);
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, notifyScheduledAt: scheduledAt, nextPhaseName: firstUpcoming.name };
  }

  const current = phases[currentIdx];
  const next = phases[currentIdx + 1];

  // Last phase — complete it and stop. No notification: there's no new
  // phase the homeowner is moving into.
  if (!next) {
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', current.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true, notifyScheduledAt: null, nextPhaseName: null };
  }

  // Two-step: complete current, start next. Done in two queries because
  // Supabase doesn't support multi-row UPDATE with different values per
  // row in a single call; failure between them is OK because the next
  // advance will recover.
  const now = new Date().toISOString();
  const { error: e1 } = await supabase
    .from('project_phases')
    .update({ status: 'complete', completed_at: now })
    .eq('id', current.id);
  if (e1) return { ok: false, error: e1.message };

  const { error: e2 } = await supabase
    .from('project_phases')
    .update({ status: 'in_progress', started_at: now })
    .eq('id', next.id);
  if (e2) return { ok: false, error: e2.message };

  const scheduledAt = await schedulePhaseNotification(supabase, next.id);

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, notifyScheduledAt: scheduledAt, nextPhaseName: next.name };
}

/**
 * Cancel a pending homeowner notification on a project. Used by the
 * Undo button on the advance toast. RLS scopes by tenant; the action
 * accepts a project id (not a phase id) so the toast doesn't have to
 * track which specific phase row holds the pending notify.
 */
export async function cancelPhaseNotifyAction(projectId: string): Promise<PhaseActionResult> {
  const supabase = await createClient();
  await cancelPendingNotificationsForProject(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Mark the current `in_progress` phase back to `upcoming` and re-open the
 * previous `complete` phase as `in_progress`. No-op if there is no
 * previous phase or no in-progress phase. Used when the operator
 * accidentally advanced or wants to re-do a stage.
 */
/**
 * Append a new phase, or insert it after a specific existing phase.
 * The new phase is `upcoming`. Renumbers `display_order` of any
 * subsequent rows so the rail stays contiguous (1..N).
 */
export async function createPhaseAction(input: {
  projectId: string;
  name: string;
  afterPhaseId?: string;
}): Promise<PhaseActionResult> {
  const trimmed = input.name.trim();
  if (!trimmed) return { ok: false, error: 'Phase name is required.' };
  if (trimmed.length > 80) return { ok: false, error: 'Phase name is too long.' };

  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data: phases, error: listErr } = await supabase
    .from('project_phases')
    .select('id, display_order')
    .eq('project_id', input.projectId)
    .order('display_order', { ascending: true });
  if (listErr || !phases) {
    return { ok: false, error: listErr?.message ?? 'Could not load phases.' };
  }

  // Where does the new phase land?
  let insertOrder: number;
  if (input.afterPhaseId) {
    const idx = phases.findIndex((p) => p.id === input.afterPhaseId);
    if (idx === -1) return { ok: false, error: 'Anchor phase not found.' };
    insertOrder = phases[idx].display_order + 1;
  } else {
    insertOrder = (phases[phases.length - 1]?.display_order ?? 0) + 1;
  }

  // Shift any phases at-or-after insertOrder up by one. Walk in reverse
  // so each row's new value doesn't collide with another row's old value
  // (the unique constraint is dropped, but staying tidy is still nice).
  const toShift = phases.filter((p) => p.display_order >= insertOrder);
  for (let i = toShift.length - 1; i >= 0; i--) {
    const p = toShift[i];
    const { error } = await supabase
      .from('project_phases')
      .update({ display_order: p.display_order + 1 })
      .eq('id', p.id);
    if (error) return { ok: false, error: error.message };
  }

  const { error: insErr } = await supabase.from('project_phases').insert({
    tenant_id: tenant.id,
    project_id: input.projectId,
    name: trimmed,
    display_order: insertOrder,
    status: 'upcoming',
  });
  if (insErr) return { ok: false, error: insErr.message };

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

/**
 * Rename a phase. Pure name update; does not touch order or status.
 */
export async function renamePhaseAction(input: {
  phaseId: string;
  name: string;
}): Promise<PhaseActionResult> {
  const trimmed = input.name.trim();
  if (!trimmed) return { ok: false, error: 'Phase name is required.' };
  if (trimmed.length > 80) return { ok: false, error: 'Phase name is too long.' };

  const supabase = await createClient();
  const { data: phase, error: lookupErr } = await supabase
    .from('project_phases')
    .select('project_id')
    .eq('id', input.phaseId)
    .single();
  if (lookupErr || !phase) return { ok: false, error: 'Phase not found.' };

  const { error } = await supabase
    .from('project_phases')
    .update({ name: trimmed, updated_at: new Date().toISOString() })
    .eq('id', input.phaseId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${(phase as { project_id: string }).project_id}`);
  return { ok: true };
}

/**
 * Delete a phase and renumber subsequent rows so the rail stays
 * contiguous. Refuses to delete the in_progress phase: contractor must
 * regress (or advance) first to move the marker elsewhere. Refuses to
 * delete the only phase on a project — every project needs at least one.
 */
export async function deletePhaseAction(phaseId: string): Promise<PhaseActionResult> {
  const supabase = await createClient();

  const { data: phase, error: lookupErr } = await supabase
    .from('project_phases')
    .select('id, project_id, status, display_order')
    .eq('id', phaseId)
    .single();
  if (lookupErr || !phase) return { ok: false, error: 'Phase not found.' };

  if (phase.status === 'in_progress') {
    return {
      ok: false,
      error: 'Cannot delete the current phase. Move to a different phase first.',
    };
  }

  const { data: siblings, error: sibErr } = await supabase
    .from('project_phases')
    .select('id, display_order')
    .eq('project_id', phase.project_id)
    .order('display_order', { ascending: true });
  if (sibErr || !siblings) {
    return { ok: false, error: sibErr?.message ?? 'Could not load phases.' };
  }
  if (siblings.length <= 1) {
    return { ok: false, error: 'A project needs at least one phase.' };
  }

  const { error: delErr } = await supabase.from('project_phases').delete().eq('id', phaseId);
  if (delErr) return { ok: false, error: delErr.message };

  // Compact display_order for any phase that came after the deleted one.
  const toShift = siblings.filter((p) => p.display_order > phase.display_order);
  for (const s of toShift) {
    const { error } = await supabase
      .from('project_phases')
      .update({ display_order: s.display_order - 1 })
      .eq('id', s.id);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${phase.project_id}`);
  return { ok: true };
}

/**
 * Bulk reorder. Client sends the new ordered list of phase IDs; the
 * array index becomes the new display_order (1-based). Single pass per
 * row — the unique constraint on (project_id, display_order) is dropped
 * in migration 0192 so we don't need a two-pass shuffle.
 */
export async function reorderPhasesAction(input: {
  projectId: string;
  orderedIds: string[];
}): Promise<PhaseActionResult> {
  const supabase = await createClient();

  const { data: existing, error: listErr } = await supabase
    .from('project_phases')
    .select('id')
    .eq('project_id', input.projectId);
  if (listErr || !existing) {
    return { ok: false, error: listErr?.message ?? 'Could not load phases.' };
  }
  if (existing.length !== input.orderedIds.length) {
    return { ok: false, error: 'Reorder list does not match current phases.' };
  }
  const existingIds = new Set(existing.map((p) => p.id));
  for (const id of input.orderedIds) {
    if (!existingIds.has(id)) return { ok: false, error: 'Unknown phase in reorder list.' };
  }

  for (let i = 0; i < input.orderedIds.length; i++) {
    const { error } = await supabase
      .from('project_phases')
      .update({ display_order: i + 1 })
      .eq('id', input.orderedIds[i]);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true };
}

export async function regressPhaseAction(projectId: string): Promise<PhaseActionResult> {
  const supabase = await createClient();

  const { data: phases, error: listErr } = await supabase
    .from('project_phases')
    .select('id, status, display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });

  if (listErr || !phases) return { ok: false, error: listErr?.message ?? 'Could not load phases.' };

  // Going backwards always invalidates any pending notify — the
  // homeowner shouldn't get a "moved to X" message about a phase the
  // operator just stepped away from.
  await cancelPendingNotificationsForProject(supabase, projectId);

  const currentIdx = phases.findIndex((p) => p.status === 'in_progress');

  // No in-progress phase — last one might be complete; re-open it.
  if (currentIdx === -1) {
    // Find the last complete phase.
    let lastCompleteIdx = -1;
    for (let i = phases.length - 1; i >= 0; i--) {
      if (phases[i].status === 'complete') {
        lastCompleteIdx = i;
        break;
      }
    }
    if (lastCompleteIdx === -1) return { ok: true }; // nothing to regress
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'in_progress', completed_at: null })
      .eq('id', phases[lastCompleteIdx].id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  }

  const current = phases[currentIdx];
  const prev = phases[currentIdx - 1];

  // First phase — just reset it to upcoming.
  if (!prev) {
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'upcoming', started_at: null })
      .eq('id', current.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  }

  const { error: e1 } = await supabase
    .from('project_phases')
    .update({ status: 'upcoming', started_at: null })
    .eq('id', current.id);
  if (e1) return { ok: false, error: e1.message };

  const { error: e2 } = await supabase
    .from('project_phases')
    .update({ status: 'in_progress', completed_at: null })
    .eq('id', prev.id);
  if (e2) return { ok: false, error: e2.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
