/**
 * POST /api/twilio/webhook/status
 *
 * Twilio delivery status callback. Fires as the message moves through
 *   queued → sent → delivered | failed | undelivered.
 *
 * We match by Twilio's MessageSid and update the twilio_messages row.
 *
 * Twilio posts as x-www-form-urlencoded, NOT JSON. Signature validation
 * is checked via X-Twilio-Signature header using the auth token.
 */

import twilio from 'twilio';
import { createAdminClient } from '@/lib/supabase/admin';

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!validateTwilioSignature(request, rawBody)) {
    return new Response('Invalid signature', { status: 403 });
  }

  const params = new URLSearchParams(rawBody);
  const sid = params.get('MessageSid');
  const status = params.get('MessageStatus'); // sent, delivered, failed, undelivered
  const errorCode = params.get('ErrorCode');
  const errorMessage = params.get('ErrorMessage');
  const price = params.get('Price');

  if (!sid || !status) {
    return new Response('Missing MessageSid or MessageStatus', { status: 400 });
  }

  const supabase = createAdminClient();
  const patch: Record<string, unknown> = { status };
  if (status === 'delivered') patch.delivered_at = new Date().toISOString();
  if (errorCode) patch.error_code = errorCode;
  if (errorMessage) patch.error_message = errorMessage;
  if (price) {
    const n = Number.parseFloat(price);
    // Twilio returns a negative number (cost to us). Store abs for sanity.
    if (!Number.isNaN(n)) patch.price_usd = Math.abs(n);
  }

  await supabase.from('twilio_messages').update(patch).eq('sid', sid);

  return new Response('', { status: 204 });
}

function validateTwilioSignature(request: Request, rawBody: string): boolean {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return false;

  const signature = request.headers.get('x-twilio-signature');
  if (!signature) return false;

  // Twilio signs the full URL including query string.
  const url = request.url;
  const params = Object.fromEntries(new URLSearchParams(rawBody));
  return twilio.validateRequest(authToken, signature, url, params);
}
