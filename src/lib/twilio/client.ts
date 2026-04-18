/**
 * Twilio client wrapper.
 *
 * Single entry point for sending SMS. Handles:
 *   - Country-code-based sender selection (US → TWILIO_FROM_US, etc.)
 *   - Opt-out enforcement (refuses to send to numbers in sms_preferences)
 *   - Logging every send into twilio_messages (queued → updated by webhook)
 *   - Graceful error propagation
 *
 * NOT responsible for:
 *   - Template rendering (callers pass a finalized body)
 *   - Scheduling / deferred sends (separate scheduler layer)
 *
 * All writes go through the Supabase service-role client — RLS doesn't apply
 * to the Twilio pipeline because the tenant is resolved by the caller.
 */

import twilio, { type Twilio } from 'twilio';
import { createAdminClient } from '@/lib/supabase/admin';

export type SendIdentity = 'operator' | 'platform';

export type SendSmsInput = {
  tenantId: string;
  to: string;
  body: string;
  identity?: SendIdentity;
  relatedType?: 'job' | 'quote' | 'invoice' | 'customer' | 'support_ticket' | 'platform';
  relatedId?: string;
};

export type SendSmsResult =
  | { ok: true; id: string; sid: string }
  | { ok: false; error: string; code?: string };

// ---------------------------------------------------------------------------
// Lazy-init Twilio client (same pattern as Stripe/Resend/Anthropic)
// ---------------------------------------------------------------------------

let _client: Twilio | null = null;
function getTwilioClient(): Twilio {
  if (!_client) {
    const sid = process.env.TWILIO_ACCOUNT_SID;
    const token = process.env.TWILIO_AUTH_TOKEN;
    if (!sid || !token) {
      throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set');
    }
    _client = twilio(sid, token);
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Sender selection by destination country
// ---------------------------------------------------------------------------

/**
 * Rough country routing for E.164 numbers. Defaults to TWILIO_FROM_DEFAULT
 * if no country-specific number is configured for the destination.
 */
function pickFromNumber(to: string): string {
  const def = process.env.TWILIO_FROM_DEFAULT ?? process.env.TWILIO_FROM_US ?? '';
  if (!to.startsWith('+')) return def;

  // +1 NPA (3 digits) for NANP. US vs Canada is by area code, not country
  // code, so we look up a small table of Canadian NPAs first.
  if (to.startsWith('+1')) {
    const npa = to.slice(2, 5);
    if (isCanadianNpa(npa)) {
      return process.env.TWILIO_FROM_CA || def;
    }
    return process.env.TWILIO_FROM_US || def;
  }

  // Placeholder for future countries. Add +44 → UK, +61 → AU, etc. when
  // we provision numbers.
  return def;
}

/**
 * Minimal table of Canadian area codes. Not exhaustive — covers the
 * provinces we actually serve (BC, AB, ON) plus the common ones. A full
 * NPA table lives in the CNA database but this is sufficient until we
 * build out a real routing service.
 */
const CANADIAN_NPAS = new Set([
  // BC
  '236',
  '250',
  '257',
  '604',
  '672',
  '778',
  // AB
  '368',
  '403',
  '587',
  '780',
  '825',
  // ON
  '226',
  '249',
  '289',
  '343',
  '365',
  '416',
  '437',
  '519',
  '548',
  '613',
  '647',
  '683',
  '705',
  '742',
  '807',
  '905',
  // MB, SK, NS, NB, NL, PE, QC, YT/NT/NU — common ones
  '204',
  '431',
  '306',
  '639',
  '418',
  '438',
  '450',
  '514',
  '579',
  '581',
  '819',
  '873',
  '506',
  '709',
  '782',
  '902',
  '867',
]);

function isCanadianNpa(npa: string): boolean {
  return CANADIAN_NPAS.has(npa);
}

// ---------------------------------------------------------------------------
// Opt-out check
// ---------------------------------------------------------------------------

async function isOptedOut(to: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('sms_preferences')
    .select('opted_out')
    .eq('phone_number', to)
    .maybeSingle();
  return !!data?.opted_out;
}

// ---------------------------------------------------------------------------
// Main send
// ---------------------------------------------------------------------------

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const { tenantId, to, body, identity = 'operator', relatedType, relatedId } = input;

  if (!to || !body) {
    return { ok: false, error: 'to and body are required' };
  }
  if (!to.startsWith('+')) {
    return { ok: false, error: `Phone number must be E.164 (got "${to}")` };
  }

  if (await isOptedOut(to)) {
    return { ok: false, error: `Recipient ${to} has opted out of SMS`, code: 'opted_out' };
  }

  const from = pickFromNumber(to);
  if (!from) {
    return { ok: false, error: 'No Twilio from-number configured' };
  }

  const supabase = createAdminClient();

  // 1. Pre-log as queued so we have a row if the Twilio call throws.
  const { data: row, error: insertErr } = await supabase
    .from('twilio_messages')
    .insert({
      tenant_id: tenantId,
      direction: 'outbound',
      identity,
      from_number: from,
      to_number: to,
      body,
      related_type: relatedType ?? null,
      related_id: relatedId ?? null,
      status: 'queued',
    })
    .select('id')
    .single();

  if (insertErr || !row) {
    return { ok: false, error: `DB insert failed: ${insertErr?.message ?? 'unknown'}` };
  }

  // 2. Fire the Twilio API call.
  try {
    const client = getTwilioClient();
    const msg = await client.messages.create({
      from,
      to,
      body,
      statusCallback: `${appBaseUrl()}/api/twilio/webhook/status`,
    });

    // 3. Update the row with the SID + initial status Twilio returned.
    await supabase
      .from('twilio_messages')
      .update({
        sid: msg.sid,
        status: msg.status ?? 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', row.id);

    return { ok: true, id: row.id, sid: msg.sid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // biome-ignore lint/suspicious/noExplicitAny: twilio error shape
    const code = (e as any)?.code ? String((e as any).code) : undefined;

    await supabase
      .from('twilio_messages')
      .update({
        status: 'failed',
        error_message: msg,
        error_code: code ?? null,
      })
      .eq('id', row.id);

    return { ok: false, error: msg, code };
  }
}

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') || 'https://app.heyhenry.io';
}
