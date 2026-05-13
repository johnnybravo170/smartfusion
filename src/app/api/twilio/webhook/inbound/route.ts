/**
 * POST /api/twilio/webhook/inbound
 *
 * Handles incoming SMS from customers / operators.
 *
 * For now we:
 *   - Log the message into twilio_messages (direction='inbound')
 *   - Honor STOP / START / UNSUBSCRIBE / CANCEL (opt-out) and START / YES / UNSTOP (opt-in)
 *     by updating sms_preferences
 *   - Acknowledge opt-outs with a plain-text reply
 *
 * Tenant routing by from-number (which operator's fleet did this land on)
 * is deferred until we have per-tenant numbers; for the shared test number
 * every inbound lands on the platform tenant context.
 *
 * Twilio expects a TwiML response or an empty 204. We reply with TwiML for
 * confirmed opt-out/opt-in, empty otherwise.
 */

import twilio from 'twilio';
import { handleCustomerInboundSms } from '@/lib/messaging/sms-customer-router';
import { createAdminClient } from '@/lib/supabase/admin';
import { claimWebhookEvent } from '@/lib/webhooks/idempotency';

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!validateTwilioSignature(request, rawBody)) {
    return new Response('Invalid signature', { status: 403 });
  }

  const params = new URLSearchParams(rawBody);
  const from = params.get('From') ?? '';
  const to = params.get('To') ?? '';
  const body = (params.get('Body') ?? '').trim();
  const sid = params.get('MessageSid') ?? '';

  // Idempotency: MessageSid is unique per inbound delivery. Re-delivery
  // would otherwise insert a duplicate twilio_messages row and re-run
  // STOP/START handling.
  if (sid) {
    const claim = await claimWebhookEvent('twilio:inbound', sid, Object.fromEntries(params));
    if (claim.alreadyProcessed) {
      return new Response(null, { status: 204 });
    }
  }

  const normalized = body.toLowerCase();
  const isStop = STOP_KEYWORDS.has(normalized);
  const isStart = START_KEYWORDS.has(normalized);

  const supabase = createAdminClient();

  // Route by To-number → tenant when the recipient is a per-tenant
  // 10DLC number (tenants.twilio_from_number). Falls back to the
  // platform tenant for shared/unassigned numbers during the rollout
  // window.
  let resolvedTenantId: string | null = null;
  if (to) {
    const { data: tenantByNumber } = await supabase
      .from('tenants')
      .select('id')
      .eq('twilio_from_number', to)
      .maybeSingle();
    resolvedTenantId = (tenantByNumber?.id as string | undefined) ?? null;
  }
  const loggedTenantId = resolvedTenantId ?? process.env.PLATFORM_TENANT_ID ?? null;
  if (loggedTenantId) {
    await supabase.from('twilio_messages').insert({
      tenant_id: loggedTenantId,
      sid,
      direction: 'inbound',
      identity: 'operator',
      from_number: from,
      to_number: to,
      body,
      status: 'received',
      related_type: null,
      related_id: null,
    });
  }

  // Update sms_preferences + last_inbound_at regardless of content.
  const now = new Date().toISOString();
  if (isStop) {
    await supabase.from('sms_preferences').upsert(
      {
        phone_number: from,
        opted_out: true,
        opted_out_at: now,
        source: 'stop_reply',
        last_inbound_at: now,
        updated_at: now,
      },
      { onConflict: 'phone_number' },
    );
    // CASL: STOP applies platform-wide. Flip do_not_auto_message on every
    // customer row matching this phone number across all tenants.
    await supabase
      .from('customers')
      .update({
        do_not_auto_message: true,
        do_not_auto_message_at: now,
        do_not_auto_message_source: 'sms_stop',
      })
      .eq('phone', from)
      .eq('do_not_auto_message', false);
  } else if (isStart) {
    await supabase.from('sms_preferences').upsert(
      {
        phone_number: from,
        opted_out: false,
        opted_out_at: null,
        last_inbound_at: now,
        updated_at: now,
      },
      { onConflict: 'phone_number' },
    );
  } else {
    await supabase.from('sms_preferences').upsert(
      {
        phone_number: from,
        last_inbound_at: now,
        updated_at: now,
      },
      { onConflict: 'phone_number', ignoreDuplicates: false },
    );
  }

  // Phase 3 of PROJECT_MESSAGING_PLAN.md — for non-STOP/START messages,
  // try to route to a project_messages thread. If the sender's phone
  // matches a customer on exactly one (tenant, project) tuple — or
  // disambiguates via recent outbound — we insert as channel='sms',
  // direction='inbound' and notify the operators. Best-effort; failure
  // doesn't block the TwiML response.
  let projectRouted = false;
  if (!isStop && !isStart && body.length > 0) {
    try {
      const result = await handleCustomerInboundSms({
        twilioSid: sid,
        fromPhone: from,
        toPhone: to,
        body,
        // Hint when the To-number is owned by a tenant — the resolver
        // narrows candidate search to that tenant first, eliminating
        // multi-tenant collisions on shared numbers.
        toTenantId: resolvedTenantId,
      });
      projectRouted = result.ok;
    } catch (err) {
      console.error('[twilio-inbound] project routing failed', err);
    }
  }

  // TwiML reply. Empty for normal messages (the customer already sees
  // their own SMS — a bot reply would be confusing), explicit
  // confirmation for STOP/START so carriers see we're respecting the
  // opt-out lifecycle.
  const twiml = new twilio.twiml.MessagingResponse();
  if (isStop) {
    twiml.message("You've been unsubscribed. Reply START to opt back in.");
  } else if (isStart) {
    twiml.message("You're re-subscribed. Reply STOP any time to opt out.");
  }
  // projectRouted intentionally produces no TwiML — the operator will
  // see the message in their portal/Messages tab and respond there.

  void projectRouted;

  return new Response(twiml.toString(), {
    status: 200,
    headers: { 'Content-Type': 'text/xml' },
  });
}

function validateTwilioSignature(request: Request, rawBody: string): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) return false;

  const url = request.url;
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  return twilio.validateRequest(authToken, signature, url, params);
}
