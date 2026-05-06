/**
 * Inbound handler for customer email replies that route into the
 * project_messages thread.
 *
 * Phase 2 of PROJECT_MESSAGING_PLAN.md. Called from the Postmark webhook
 * after sender classification picks the customer-reply branch (sender
 * email matches an active project's customer; sender is NOT a tenant
 * member).
 *
 * Steps:
 *   1. Loop guard — drop autoresponders before persisting.
 *   2. Resolve tenant + project via the 3-tier router (header → footer
 *      → recency). Bounce on failure.
 *   3. Insert a project_messages row with channel='email',
 *      direction='inbound', external_id from the inbound Message-ID,
 *      in_reply_to from the resolver.
 *   4. Fire immediate operator notification (reuses Phase 1's
 *      dispatcher via a dynamic import to avoid a server-action edge
 *      runtime issue).
 *
 * Returns { ok: true, messageId } on success, { ok: false, reason } on
 * loop-guard or unresolved. Caller decides whether to bounce and what
 * to log.
 */

import { sendUnknownSenderBounce } from '@/lib/inbound-email/bounce';
import { normaliseEmail } from '@/lib/inbound-email/sender-resolver';
import { resolveProjectForCustomerReply } from '@/lib/messaging/email-customer-router';
import { createAdminClient } from '@/lib/supabase/admin';

export type PostmarkHeader = { Name: string; Value: string };

export type CustomerMessageHandlerInput = {
  postmarkMessageId: string;
  fromHeader: string;
  fromName: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  headers: PostmarkHeader[];
};

export type CustomerMessageHandlerResult =
  | { ok: true; messageId: string; tenantId: string; projectId: string }
  | { ok: false; reason: 'loop_guard' | 'unresolved'; bounce?: boolean };

function getHeader(headers: PostmarkHeader[], name: string): string | null {
  const lc = name.toLowerCase();
  for (const h of headers) {
    if (h.Name.toLowerCase() === lc) return h.Value;
  }
  return null;
}

function isAutoResponder(headers: PostmarkHeader[]): boolean {
  const autoSubmitted = (getHeader(headers, 'Auto-Submitted') ?? '').toLowerCase();
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  const precedence = (getHeader(headers, 'Precedence') ?? '').toLowerCase();
  if (precedence === 'bulk' || precedence === 'auto_reply' || precedence === 'list') return true;
  // Also check the X-Auto-Response-Suppress family used by Outlook.
  if (getHeader(headers, 'X-Autoreply')) return true;
  if (getHeader(headers, 'X-Autorespond')) return true;
  return false;
}

export async function handleCustomerInboundMessage(
  input: CustomerMessageHandlerInput,
): Promise<CustomerMessageHandlerResult> {
  // 1. Loop guard.
  if (isAutoResponder(input.headers)) {
    return { ok: false, reason: 'loop_guard' };
  }

  const fromEmail = normaliseEmail(input.fromHeader);
  const inReplyTo = getHeader(input.headers, 'In-Reply-To');
  const references = getHeader(input.headers, 'References');

  // 2. Resolve.
  const resolved = await resolveProjectForCustomerReply({
    fromEmail,
    bodyText: input.bodyText,
    bodyHtml: input.bodyHtml,
    inReplyToHeader: inReplyTo,
    referencesHeader: references,
  });
  if (!resolved) {
    return { ok: false, reason: 'unresolved', bounce: true };
  }

  // 3. Insert. Strip the body footer ref token before storage so it
  // doesn't show up in the rendered thread; the resolver has already
  // consumed it.
  const cleanedBody = (input.bodyText ?? input.bodyHtml ?? '').replace(
    /\s*\[Ref:\s*P-[0-9A-Za-z]{6}\]\s*$/i,
    '',
  );
  const body = cleanedBody.trim().slice(0, 10_000);
  if (!body) {
    return { ok: false, reason: 'unresolved' };
  }

  // Prefer the email's actual Message-ID header (what other clients will
  // quote in In-Reply-To) over Postmark's internal tracking id. Fall
  // back to the tracking id if the header is missing.
  const rawMessageId =
    getHeader(input.headers, 'Message-ID') ?? getHeader(input.headers, 'Message-Id');
  const externalId = rawMessageId
    ? rawMessageId.replace(/^<|>$/g, '').trim()
    : input.postmarkMessageId;

  const admin = createAdminClient();
  const { data: inserted, error } = await admin
    .from('project_messages')
    .insert({
      tenant_id: resolved.tenantId,
      project_id: resolved.projectId,
      sender_kind: 'customer',
      sender_label: input.fromName ?? fromEmail,
      channel: 'email',
      direction: 'inbound',
      body,
      external_id: externalId,
      in_reply_to: null, // FK requires a project_messages.id, not a Message-ID.
      // Customer's own message — already-read on their side.
      read_by_customer_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !inserted) {
    console.error('[customer-message-handler] insert failed', error);
    return { ok: false, reason: 'unresolved' };
  }

  // If we found the prior outbound row via In-Reply-To, link via
  // in_reply_to. Done as a separate update so the FK can resolve
  // against the same row id we found in the resolver.
  if (resolved.inReplyToMessageId) {
    const { data: priorRow } = await admin
      .from('project_messages')
      .select('id')
      .eq('external_id', resolved.inReplyToMessageId)
      .maybeSingle();
    if (priorRow) {
      await admin
        .from('project_messages')
        .update({ in_reply_to: priorRow.id })
        .eq('id', inserted.id as string);
    }
  }

  // 4. Operator notification — best-effort, dynamic import to avoid
  // pulling Phase 1's notify dispatch through every place this module
  // gets bundled.
  try {
    const { dispatchCustomerMessageToOperators } = await import(
      '@/lib/portal/customer-message-operator-notify'
    );
    await dispatchCustomerMessageToOperators({
      admin,
      tenantId: resolved.tenantId,
      projectId: resolved.projectId,
      customerName: input.fromName ?? fromEmail,
      body,
    });
  } catch (err) {
    console.error('[customer-message-handler] operator notify failed', err);
  }

  return {
    ok: true,
    messageId: inserted.id as string,
    tenantId: resolved.tenantId,
    projectId: resolved.projectId,
  };
}

/** Wrapper around the existing bounce sender for the unresolved case. */
export async function bounceUnresolvedCustomerReply(args: {
  to: string;
  originalSubject: string;
}): Promise<void> {
  await sendUnknownSenderBounce({
    to: args.to,
    originalSubject: args.originalSubject,
  });
}
