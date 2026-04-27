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
import { createAdminClient } from '@/lib/supabase/admin';

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

  const normalized = body.toLowerCase();
  const isStop = STOP_KEYWORDS.has(normalized);
  const isStart = START_KEYWORDS.has(normalized);

  const supabase = createAdminClient();

  // Log the inbound message. We don't yet have a tenant routing story, so
  // tenant_id is nullable conceptually — but our schema requires it. Park
  // under the platform admin tenant via env, or skip logging if unset.
  const platformTenantId = process.env.PLATFORM_TENANT_ID;
  if (platformTenantId) {
    await supabase.from('twilio_messages').insert({
      tenant_id: platformTenantId,
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

  // TwiML reply. Empty for non-keyword messages, explicit confirmation for
  // STOP/START so carriers see we're respecting the opt-out lifecycle.
  const twiml = new twilio.twiml.MessagingResponse();
  if (isStop) {
    twiml.message("You've been unsubscribed. Reply START to opt back in.");
  } else if (isStart) {
    twiml.message("You're re-subscribed. Reply STOP any time to opt out.");
  }

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
