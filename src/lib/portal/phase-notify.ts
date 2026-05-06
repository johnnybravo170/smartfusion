/**
 * Send the homeowner notification for a phase transitioning to in_progress.
 *
 * Used exclusively by the deferred-notify cron drainer
 * (/api/cron/portal-phase-notify). The phase advance server action
 * doesn't fire notifications synchronously anymore — it just schedules
 * them via project_phases.notify_scheduled_at.
 *
 * Best-effort: failures in SMS or email don't throw; we log and move on
 * so a flaky Twilio call doesn't poison-pill an otherwise valid send.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/send';
import { appendCustomerEmailFooter, CUSTOMER_REPLY_TO } from '@/lib/messaging/email-outbound';
import { sendSms } from '@/lib/twilio/client';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendPhaseNotificationInput = {
  /** Admin Supabase client (RLS-bypassing). The cron drainer has no
   *  tenant context, so we pass tenantId explicitly for CASL evidence. */
  supabase: SupabaseClient;
  tenantId: string;
  projectId: string;
  phaseId: string;
  phaseName: string;
};

export async function sendPhaseNotification(input: SendPhaseNotificationInput): Promise<void> {
  const { data: project } = await input.supabase
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
  // No portal = no homeowner-facing surface; don't message about phases
  // they can't see anyway.
  if (!portalSlug || !portalEnabled) return;

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
      tenantId: input.tenantId,
      to: phoneRaw,
      body,
      relatedType: 'job',
      relatedId: input.projectId,
      caslCategory: 'transactional',
      caslEvidence: { kind: 'phase_change_notify', projectId: input.projectId },
    }).catch((err) => console.error('[phase-notify] sms failed:', err));
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
      tenantId: input.tenantId,
      to: emailRaw,
      subject: `${projectName} — ${input.phaseName}`,
      html: appendCustomerEmailFooter(html, input.projectId),
      replyTo: CUSTOMER_REPLY_TO,
      caslCategory: 'transactional',
      relatedType: 'job',
      relatedId: input.projectId,
      caslEvidence: { kind: 'phase_change_notify', projectId: input.projectId },
    }).catch((err) => console.error('[phase-notify] email failed:', err));
  }

  // The operator-side milestone row in project_portal_updates is
  // written immediately on advance (see advancePhaseAction). The cron
  // drainer only handles SMS + email — it does not write to the feed,
  // because that would create duplicate rows alongside the immediate
  // write.
}
