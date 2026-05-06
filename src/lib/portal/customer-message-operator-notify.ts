/**
 * Operator-side notification dispatcher when a customer message lands
 * (regardless of channel — portal, email, eventually SMS).
 *
 * Extracted from src/server/actions/project-messages.ts so both the
 * server action (Phase 1's portal-channel inbound) and the email
 * inbound handler (Phase 2) can reuse it. Same notify-pref logic;
 * same email template; immediate (no defer).
 */

import { sendEmail } from '@/lib/email/send';
import { projectMessageOperatorNotificationHtml } from '@/lib/email/templates/project-message-operator-notification';
import type { createAdminClient } from '@/lib/supabase/admin';
import { sendSms } from '@/lib/twilio/client';

export async function dispatchCustomerMessageToOperators(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  projectId: string;
  customerName: string;
  body: string;
  /** Optional override; defaults to the project's name. */
  projectName?: string;
}): Promise<void> {
  const { admin, tenantId, projectId, customerName, body } = args;

  let projectName = args.projectName;
  if (!projectName) {
    const { data: project } = await admin
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .maybeSingle();
    projectName = (project?.name as string | undefined) ?? 'their project';
  }

  const { data: members } = await admin
    .from('tenant_members')
    .select('user_id, notification_phone, notify_prefs, role')
    .eq('tenant_id', tenantId)
    .in('role', ['owner', 'admin']);

  const memberRows = members ?? [];
  if (memberRows.length === 0) return;

  const { data: users } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailByUserId = new Map<string, string>();
  for (const u of users?.users ?? []) {
    if (u.id && u.email) emailByUserId.set(u.id, u.email);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.heyhenry.io';
  const projectUrl = `${appUrl}/projects/${projectId}?tab=messages`;
  const subject = `💬 New message from ${customerName} on ${projectName}`;
  const html = projectMessageOperatorNotificationHtml({
    customerName,
    projectName,
    projectUrl,
    body,
  });
  const smsExcerpt = body.length > 120 ? `${body.slice(0, 117).trimEnd()}…` : body;
  const smsBody = `${customerName}: "${smsExcerpt}"\n${projectUrl}`;

  for (const m of memberRows) {
    const prefs = (m.notify_prefs as Record<string, Record<string, boolean> | undefined>) ?? {};
    const want = prefs.customer_feedback ?? { email: true, sms: false };

    if (want.email) {
      const email = emailByUserId.get(m.user_id as string);
      if (email) {
        await sendEmail({
          tenantId,
          to: email,
          subject,
          html,
          caslCategory: 'transactional',
          relatedType: 'job',
          relatedId: projectId,
          caslEvidence: { kind: 'project_message_internal_notify', projectId },
        }).catch((err) => console.error('[customer-msg-notify] email failed:', err));
      }
    }

    if (want.sms) {
      const phone = (m.notification_phone as string | null) ?? '';
      if (phone) {
        await sendSms({
          tenantId,
          to: phone,
          body: smsBody,
          relatedType: 'platform',
          caslCategory: 'transactional',
          caslEvidence: { kind: 'project_message_internal_notify', projectId },
        }).catch((err) => console.error('[customer-msg-notify] sms failed:', err));
      }
    }
  }
}
