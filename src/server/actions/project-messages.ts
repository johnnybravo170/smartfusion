'use server';

/**
 * Server actions for the project messaging thread.
 *
 * Phase 1 of PROJECT_MESSAGING_PLAN.md — portal channel only. Operator
 * and customer post into the same project_messages table; everyone sees
 * the same scrollback.
 *
 * Outbound (operator → customer) notifications are DEFERRED via the same
 * cancel-and-reschedule pattern as project-phases (PORTAL_PHASES_PLAN.md
 * Phase 2). Inbound (customer → operator) notifications fire immediately
 * — operators want to know straight away when the customer says
 * something, but the customer should not be peppered with a chain of
 * texts when an operator types fast.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { sendEmail } from '@/lib/email/send';
import { projectMessageOperatorNotificationHtml } from '@/lib/email/templates/project-message-operator-notification';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';

export type MessageActionResult = { ok: true; id: string } | { ok: false; error: string };
export type SimpleResult = { ok: true } | { ok: false; error: string };

/**
 * How long to wait before firing the customer notification, in seconds.
 * Shorter than the phase delay (5 min) because messages are inherently
 * conversational — a 30s window is enough to cover "let me also add…"
 * follow-ups without making the customer feel like the contractor is
 * asleep at the wheel.
 */
const NOTIFY_DELAY_SECONDS = 30;

const MAX_BODY_LENGTH = 10_000;

function trimBody(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, MAX_BODY_LENGTH);
}

async function cancelPendingOutboundNotifyForProject(
  supabase: Awaited<ReturnType<typeof createClient>>,
  projectId: string,
): Promise<void> {
  await supabase
    .from('project_messages')
    .update({ notify_cancelled_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('direction', 'outbound')
    .is('notify_sent_at', null)
    .is('notify_cancelled_at', null)
    .not('notify_scheduled_at', 'is', null);
}

async function scheduleMessageNotification(
  supabase: Awaited<ReturnType<typeof createClient>>,
  messageId: string,
): Promise<string> {
  const scheduledAt = new Date(Date.now() + NOTIFY_DELAY_SECONDS * 1000).toISOString();
  await supabase
    .from('project_messages')
    .update({
      notify_scheduled_at: scheduledAt,
      notify_sent_at: null,
      notify_cancelled_at: null,
    })
    .eq('id', messageId);
  return scheduledAt;
}

// ============================================================================
// Operator side
// ============================================================================

export type PostProjectMessageInput = {
  projectId: string;
  body: string;
};

export type PostProjectMessageResult =
  | { ok: true; id: string; notifyScheduledAt: string | null }
  | { ok: false; error: string };

export async function postProjectMessageAction(
  input: PostProjectMessageInput,
): Promise<PostProjectMessageResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const body = trimBody(input.body);
  if (!body) return { ok: false, error: 'Message is empty.' };

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  // Resolve display label from tenant_members.first_name with auth-email
  // fallback. Mirrors how phase-notify writes a "from" line.
  const { data: member } = await supabase
    .from('tenant_members')
    .select('first_name')
    .eq('tenant_id', tenant.id)
    .eq('user_id', user.id)
    .maybeSingle();
  const senderLabel = (member?.first_name as string | undefined) ?? user.email ?? 'Operator';

  // Whenever we add a new outbound message, the prior pending notify
  // (if any) becomes stale — the customer should hear about the latest
  // message body, not an obsolete one. Cancel first; new schedule
  // follows immediately.
  await cancelPendingOutboundNotifyForProject(supabase, input.projectId);

  const { data: inserted, error } = await supabase
    .from('project_messages')
    .insert({
      tenant_id: tenant.id,
      project_id: input.projectId,
      sender_kind: 'operator',
      sender_user_id: user.id,
      sender_label: senderLabel,
      channel: 'portal',
      direction: 'outbound',
      body,
      // Operator's own outbound shows as already-read by the operator;
      // customer hasn't seen it yet.
      read_by_operator_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !inserted) {
    return { ok: false, error: error?.message ?? 'Could not save message.' };
  }

  const messageId = inserted.id as string;
  const scheduledAt = await scheduleMessageNotification(supabase, messageId);

  revalidatePath(`/projects/${input.projectId}`);
  return { ok: true, id: messageId, notifyScheduledAt: scheduledAt };
}

/**
 * Cancel any pending outbound notification for this project. Used by
 * the Undo affordance on the post-message toast. Project-scoped (not
 * message-scoped) for the same reason as cancelPhaseNotifyAction —
 * the toast doesn't need to know which row holds the pending notify.
 */
export async function cancelProjectMessageNotifyAction(projectId: string): Promise<SimpleResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  await cancelPendingOutboundNotifyForProject(supabase, projectId);
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Mark all inbound messages on this project as read by the operator.
 * Called when the operator opens the Messages tab.
 */
export async function markProjectMessagesReadAction(projectId: string): Promise<SimpleResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('project_messages')
    .update({ read_by_operator_at: new Date().toISOString() })
    .eq('project_id', projectId)
    .eq('direction', 'inbound')
    .is('read_by_operator_at', null);

  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export type MessageRow = {
  id: string;
  sender_kind: 'operator' | 'customer' | 'system' | 'henry';
  sender_label: string | null;
  channel: 'portal' | 'email' | 'sms';
  direction: 'inbound' | 'outbound' | 'internal';
  body: string;
  created_at: string;
  read_by_operator_at: string | null;
  read_by_customer_at: string | null;
};

/**
 * Operator-side polling fetch. Returns the full thread for the given
 * project. Tenant scoping is enforced by RLS on the authenticated
 * server client.
 */
export async function getProjectMessagesAction(
  projectId: string,
): Promise<{ ok: true; messages: MessageRow[] } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_messages')
    .select(
      'id, sender_kind, sender_label, channel, direction, body, created_at, read_by_operator_at, read_by_customer_at',
    )
    .eq('project_id', projectId)
    .order('created_at', { ascending: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true, messages: (data ?? []) as MessageRow[] };
}

// ============================================================================
// Customer side (portal slug auth)
// ============================================================================

export type PostCustomerMessageResult = { ok: true } | { ok: false; error: string };

/**
 * Customer posts a message from the public portal. Auth is the
 * portal_slug + portal_enabled check — same convention as the rest of
 * the public portal (see /portal/[slug]/page.tsx). Uses the admin
 * client because there is no Supabase auth context for portal visitors.
 */
export async function postCustomerPortalMessageAction(input: {
  portalSlug: string;
  body: string;
}): Promise<PostCustomerMessageResult> {
  const body = trimBody(input.body);
  if (!body) return { ok: false, error: 'Message is empty.' };

  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select('id, tenant_id, name, portal_slug, portal_enabled, customers:customer_id (name)')
    .eq('portal_slug', input.portalSlug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();

  if (!project) return { ok: false, error: 'Portal not found.' };

  const p = project as Record<string, unknown>;
  const projectId = p.id as string;
  const tenantId = p.tenant_id as string;
  const projectName = (p.name as string) ?? 'their project';
  const customer = (p.customers as Record<string, unknown> | null) ?? null;
  const customerName = (customer?.name as string | undefined) ?? 'the customer';

  const { error: insErr } = await admin.from('project_messages').insert({
    tenant_id: tenantId,
    project_id: projectId,
    sender_kind: 'customer',
    sender_label: customerName,
    channel: 'portal',
    direction: 'inbound',
    body,
    // Customer's own message shows as already-read on their side.
    read_by_customer_at: new Date().toISOString(),
  });

  if (insErr) return { ok: false, error: insErr.message };

  // Fire operator notifications immediately (no defer for inbound).
  await dispatchCustomerMessageToOperators({
    admin,
    tenantId,
    projectId,
    projectName,
    customerName,
    body,
  }).catch((err) => console.error('[project-message] operator notify failed:', err));

  return { ok: true };
}

/**
 * Customer-side polling fetch. Returns the messages for the given portal
 * slug. Authentication is the same portal_slug + portal_enabled check
 * used by the portal page itself.
 */
export async function getCustomerPortalMessagesAction(
  portalSlug: string,
): Promise<{ ok: true; messages: MessageRow[] } | { ok: false; error: string }> {
  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('portal_slug', portalSlug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();

  if (!project) return { ok: false, error: 'Portal not found.' };

  const { data, error } = await admin
    .from('project_messages')
    .select(
      'id, sender_kind, sender_label, channel, direction, body, created_at, read_by_operator_at, read_by_customer_at',
    )
    .eq('project_id', (project as { id: string }).id)
    .order('created_at', { ascending: true });

  if (error) return { ok: false, error: error.message };
  return { ok: true, messages: (data ?? []) as MessageRow[] };
}

/**
 * Customer marks all outbound messages (operator → customer) as read.
 * Called when the customer opens the Messages tab on the portal.
 */
export async function markCustomerPortalMessagesReadAction(
  portalSlug: string,
): Promise<SimpleResult> {
  const admin = createAdminClient();

  const { data: project } = await admin
    .from('projects')
    .select('id')
    .eq('portal_slug', portalSlug)
    .eq('portal_enabled', true)
    .is('deleted_at', null)
    .single();

  if (!project) return { ok: false, error: 'Portal not found.' };

  const { error } = await admin
    .from('project_messages')
    .update({ read_by_customer_at: new Date().toISOString() })
    .eq('project_id', (project as { id: string }).id)
    .eq('direction', 'outbound')
    .is('read_by_customer_at', null);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ============================================================================
// Operator notification dispatch (immediate — no defer)
// ============================================================================

/**
 * Fire the operator-side notifications when a customer posts a message
 * in the portal. Mirrors dispatchFeedbackNotifications in
 * estimate-approval.ts — owner/admin members only, per-member
 * notify_prefs, best-effort email + SMS.
 */
async function dispatchCustomerMessageToOperators(args: {
  admin: ReturnType<typeof createAdminClient>;
  tenantId: string;
  projectId: string;
  projectName: string;
  customerName: string;
  body: string;
}): Promise<void> {
  const { admin, tenantId, projectId, projectName, customerName, body } = args;

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
    // Reuse the customer_feedback notify pref. Project messages and
    // estimate feedback are the same shape of event from the operator's
    // POV: "the customer said something on the portal." Splitting them
    // would create two adjacent prefs that nobody distinguishes.
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
        }).catch((err) => console.error('[project-message] email send failed:', err));
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
        }).catch((err) => console.error('[project-message] sms send failed:', err));
      }
    }
  }
}
