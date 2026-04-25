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
