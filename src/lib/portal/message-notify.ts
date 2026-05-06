/**
 * Send the customer-facing notification for an outbound project message.
 *
 * Used exclusively by the deferred-notify cron drainer
 * (/api/cron/project-message-notify). The operator-side
 * postProjectMessageAction doesn't fire notifications synchronously —
 * it just schedules them via project_messages.notify_scheduled_at, so
 * rapid-fire posts collapse into one customer email.
 *
 * Best-effort: failures in SMS or email don't throw.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { sendEmail } from '@/lib/email/send';
import {
  appendCustomerEmailFooter,
  bareMessageId,
  CUSTOMER_REPLY_TO,
  customerOutboundHeaders,
  outboundMessageId,
} from '@/lib/messaging/email-outbound';
import { sendSms } from '@/lib/twilio/client';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type SendMessageNotificationInput = {
  /** Admin Supabase client. The cron drainer has no tenant context, so
   *  we pass tenantId explicitly for CASL evidence. */
  supabase: SupabaseClient;
  tenantId: string;
  projectId: string;
  /** The message that triggered this notification — used to embed the
   *  body in the email so the customer gets the gist without clicking. */
  messageId: string;
  body: string;
  senderLabel: string;
};

export async function sendMessageNotification(input: SendMessageNotificationInput): Promise<void> {
  const { data: project } = await input.supabase
    .from('projects')
    .select(
      `id, name, portal_slug, portal_enabled,
       customers:customer_id (name, email, phone),
       tenants:tenant_id (name)`,
    )
    .eq('id', input.projectId)
    .single();
  if (!project) return;

  const p = project as Record<string, unknown>;
  const portalSlug = (p.portal_slug as string | null) ?? null;
  const portalEnabled = Boolean(p.portal_enabled);
  if (!portalSlug || !portalEnabled) return;

  const customer = (p.customers as Record<string, unknown> | null) ?? null;
  if (!customer) return;

  const customerName = (customer.name as string) ?? '';
  const first = customerName.split(/\s+/)[0] || 'there';
  const projectName = (p.name as string) ?? 'your project';
  const tenant = (p.tenants as Record<string, unknown> | null) ?? null;
  const businessName = (tenant?.name as string) ?? 'Your contractor';
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io';
  const portalUrl = `${baseUrl}/portal/${portalSlug}?tab=messages`;
  const phoneRaw = (customer.phone as string | null) ?? null;
  const emailRaw = (customer.email as string | null) ?? null;

  if (phoneRaw) {
    const excerpt = input.body.length > 120 ? `${input.body.slice(0, 117).trimEnd()}…` : input.body;
    const smsBody = `${input.senderLabel} (${businessName}): "${excerpt}"\n${portalUrl}`;
    await sendSms({
      tenantId: input.tenantId,
      to: phoneRaw,
      body: smsBody,
      relatedType: 'job',
      relatedId: input.projectId,
      caslCategory: 'transactional',
      caslEvidence: { kind: 'project_message_customer_notify', projectId: input.projectId },
    }).catch((err) => console.error('[message-notify] sms failed:', err));
  }

  if (emailRaw) {
    // Pre-write the Message-ID we're about to send onto the row's
    // external_id so the inbound resolver can match the customer's reply
    // even if Resend overrides our header. Belt-and-suspenders with the
    // body footer below.
    const messageIdHeader = outboundMessageId(input.messageId);
    await input.supabase
      .from('project_messages')
      .update({ external_id: bareMessageId(messageIdHeader) })
      .eq('id', input.messageId);

    const baseHtml = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#222;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
  <tr><td align="center" style="padding:32px 16px;">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:8px;">
      <tr><td style="padding:24px;">
        <p style="margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888;">New message</p>
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#111;">${escapeHtml(input.senderLabel)} from ${escapeHtml(businessName)} sent you a message</h1>
        <p style="margin:0 0 16px;font-size:13px;color:#666;">Project: <strong>${escapeHtml(projectName)}</strong></p>
        <div style="margin:0 0 20px;border-left:3px solid #2563eb;padding:12px 16px;background:#f8fafc;border-radius:4px;">
          <p style="margin:0;font-size:14px;line-height:1.5;color:#222;white-space:pre-wrap;">${escapeHtml(input.body)}</p>
        </div>
        <p style="margin:0 0 16px;font-size:14px;color:#444;">Hi ${escapeHtml(first)} — reply directly to this email or open your portal. Either way, we'll see it.</p>
        <p style="margin:0;"><a href="${portalUrl}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;font-weight:600;">Open your portal</a></p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
    const html = appendCustomerEmailFooter(baseHtml, input.projectId);

    await sendEmail({
      tenantId: input.tenantId,
      to: emailRaw,
      subject: `${projectName} — new message from ${businessName}`,
      html,
      replyTo: CUSTOMER_REPLY_TO,
      headers: customerOutboundHeaders(input.messageId),
      caslCategory: 'transactional',
      relatedType: 'job',
      relatedId: input.projectId,
      caslEvidence: { kind: 'project_message_customer_notify', projectId: input.projectId },
    }).catch((err) => console.error('[message-notify] email failed:', err));
  }
}
