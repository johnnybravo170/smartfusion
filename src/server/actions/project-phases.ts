'use server';

/**
 * Server actions for project phases (Slice 1 of the Customer Portal build).
 *
 * Phases are the homeowner-facing milestone roadmap. The operator advances
 * / regresses the current phase from the Portal tab. Mutations run through
 * the RLS-aware server client; tenant isolation is enforced by the
 * project_phases RLS policies (no app-side tenant filtering).
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { sendEmail } from '@/lib/email/send';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';

export type PhaseActionResult = { ok: true } | { ok: false; error: string };

/**
 * Best-effort homeowner notification when a phase transitions to
 * in_progress. Fires SMS (if customer phone) AND email (if customer
 * email). A failed notification doesn't roll back the phase change —
 * we'd rather have the phase advance than block on Twilio / Resend.
 */
async function notifyHomeownerOfPhase(input: {
  projectId: string;
  phaseName: string;
  phaseId: string;
}): Promise<void> {
  try {
    const tenant = await getCurrentTenant();
    if (!tenant) return;
    const supabase = await createClient();
    const { data: project } = await supabase
      .from('projects')
      .select(
        `id, name, portal_slug, portal_enabled,
         customers:customer_id (name, email, phone)`,
      )
      .eq('id', input.projectId)
      .single();
    if (!project) return;
    const p = project as Record<string, unknown>;
    const portalSlug = (p.portal_slug as string | null) ?? null;
    const portalEnabled = Boolean(p.portal_enabled);
    if (!portalSlug || !portalEnabled) return; // no portal = no homeowner-facing surface to point them to
    const customer = (p.customers as Record<string, unknown> | null) ?? null;
    if (!customer) return;
    const customerName = (customer.name as string) ?? '';
    const first = customerName.split(/\s+/)[0] || 'there';
    const projectName = (p.name as string) ?? 'your project';
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
    const portalUrl = `${baseUrl}/portal/${portalSlug}`;
    const phoneRaw = (customer.phone as string | null) ?? null;
    const emailRaw = (customer.email as string | null) ?? null;

    if (phoneRaw) {
      const body = `Hi ${first}, ${projectName} just moved into "${input.phaseName}". See the latest: ${portalUrl}`;
      await sendSms({
        tenantId: tenant.id,
        to: phoneRaw,
        body,
        relatedType: 'job',
        relatedId: input.projectId,
        caslCategory: 'transactional',
        caslEvidence: { kind: 'phase_change_notify', projectId: input.projectId },
      }).catch((err) => console.error('[phase-advance] sms failed:', err));
    }
    if (emailRaw) {
      const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;">
      <tr><td style="padding:24px;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;">Phase update</p>
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#111;">${escapeHtml(projectName)} just moved to ${escapeHtml(input.phaseName)}</h1>
        <p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#444;">Hi ${escapeHtml(first)}, just a quick heads-up — we&rsquo;ve started the next phase. Latest photos and updates are on your portal.</p>
        <p style="margin:0 0 8px;"><a href="${portalUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open your portal</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`.trim();
      await sendEmail({
        tenantId: tenant.id,
        to: emailRaw,
        subject: `${projectName} — ${input.phaseName}`,
        html,
        caslCategory: 'transactional',
        relatedType: 'job',
        relatedId: input.projectId,
        caslEvidence: { kind: 'phase_change_notify', projectId: input.projectId },
      }).catch((err) => console.error('[phase-advance] email failed:', err));
    }

    // Also drop a portal_updates row so the operator sees the same
    // event the homeowner saw.
    await supabase.from('project_portal_updates').insert({
      project_id: input.projectId,
      tenant_id: tenant.id,
      type: 'milestone',
      title: input.phaseName,
      body: `Phase advanced to ${input.phaseName}.`,
    });
  } catch (err) {
    console.error('[phase-advance] notify failed:', err);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Mark the current `in_progress` phase complete and the next `upcoming`
 * phase `in_progress`. No-op (returns ok) if the project is already on
 * its last phase.
 */
export async function advancePhaseAction(projectId: string): Promise<PhaseActionResult> {
  const supabase = await createClient();

  const { data: phases, error: listErr } = await supabase
    .from('project_phases')
    .select('id, status, display_order')
    .eq('project_id', projectId)
    .order('display_order', { ascending: true });

  if (listErr || !phases) return { ok: false, error: listErr?.message ?? 'Could not load phases.' };

  const currentIdx = phases.findIndex((p) => p.status === 'in_progress');
  // No current phase yet (all upcoming or all complete) — start the first one.
  if (currentIdx === -1) {
    const firstUpcoming = phases.find((p) => p.status === 'upcoming');
    if (!firstUpcoming) return { ok: true }; // all complete; nothing to advance
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', firstUpcoming.id);
    if (error) return { ok: false, error: error.message };
    // Need the phase name for the notification — fetch it.
    const { data: namedPhase } = await supabase
      .from('project_phases')
      .select('name')
      .eq('id', firstUpcoming.id)
      .single();
    const phaseName =
      ((namedPhase as Record<string, unknown> | null)?.name as string) ?? 'next phase';
    await notifyHomeownerOfPhase({ projectId, phaseName, phaseId: firstUpcoming.id });
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
  }

  const current = phases[currentIdx];
  const next = phases[currentIdx + 1];

  // Last phase — complete it and stop.
  if (!next) {
    const { error } = await supabase
      .from('project_phases')
      .update({ status: 'complete', completed_at: new Date().toISOString() })
      .eq('id', current.id);
    if (error) return { ok: false, error: error.message };
    revalidatePath(`/projects/${projectId}`);
    return { ok: true };
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

  // Notify homeowner that the project just stepped to the next phase.
  const { data: nextNamed } = await supabase
    .from('project_phases')
    .select('name')
    .eq('id', next.id)
    .single();
  const nextName = ((nextNamed as Record<string, unknown> | null)?.name as string) ?? 'next phase';
  await notifyHomeownerOfPhase({ projectId, phaseName: nextName, phaseId: next.id });

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
