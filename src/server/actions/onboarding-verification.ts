'use server';

/**
 * Onboarding verification server actions: email re-send, phone OTP send,
 * phone OTP verify. Email confirmation itself happens via the Supabase
 * link → /callback flow.
 */

import { headers } from 'next/headers';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { sendEmail } from '@/lib/email/send';
import { createAdminClient } from '@/lib/supabase/admin';
import { normalizePhone, sendSms } from '@/lib/twilio/client';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 5;
const RESEND_THROTTLE_MS = 60 * 1000; // 1 min between sends

export type VerificationResult = { ok: true } | { ok: false; error: string };

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

export async function resendEmailVerificationAction(): Promise<VerificationResult> {
  const user = await getCurrentUser();
  if (!user || !user.email) return { ok: false, error: 'Not signed in.' };
  if (user.email_confirmed_at) return { ok: true };

  const admin = createAdminClient();
  const origin = await originFromHeaders();
  // 'magiclink' confirms email on an existing unconfirmed user when clicked.
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.email,
    options: { redirectTo: `${origin}/callback?next=/onboarding/verify` },
  });
  if (error || !data?.properties?.action_link) {
    return { ok: false, error: error?.message ?? 'Could not generate link.' };
  }

  const link = data.properties.action_link;
  const result = await sendEmail({
    to: user.email,
    subject: 'Confirm your HeyHenry email',
    html: `
      <p>Hi,</p>
      <p>Confirm your email to finish setting up HeyHenry:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px;">Confirm email</a></p>
      <p>Or open this link: <br/><a href="${link}">${link}</a></p>
      <p>Link expires in 24 hours.</p>
    `,
  });
  if (!result.ok) return { ok: false, error: result.error ?? 'Email send failed.' };
  return { ok: true };
}

export async function sendPhoneVerificationAction(input: {
  phone: string;
}): Promise<VerificationResult> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const phone = normalizePhone(input.phone);
  if (!phone) {
    return {
      ok: false,
      error: 'Could not parse phone number — please include country code (e.g. +1 604 555 1234).',
    };
  }

  const admin = createAdminClient();

  // Throttle: refuse if a code was sent in the last RESEND_THROTTLE_MS.
  const { data: recent } = await admin
    .from('phone_verification_codes')
    .select('created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (recent && recent.length > 0) {
    const last = new Date(recent[0].created_at as string).getTime();
    const since = Date.now() - last;
    if (since < RESEND_THROTTLE_MS) {
      const wait = Math.ceil((RESEND_THROTTLE_MS - since) / 1000);
      return { ok: false, error: `Please wait ${wait}s before requesting another code.` };
    }
  }

  // Update the member's stored phone (so subsequent UI sees it) — keep
  // phone_verified_at NULL until verification completes.
  await admin
    .from('tenant_members')
    .update({ phone, phone_verified_at: null })
    .eq('user_id', user.id)
    .eq('tenant_id', tenant.id);

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  const { error: insErr } = await admin.from('phone_verification_codes').insert({
    user_id: user.id,
    tenant_id: tenant.id,
    phone,
    code,
    expires_at: expiresAt,
  });
  if (insErr) return { ok: false, error: insErr.message };

  const sms = await sendSms({
    tenantId: tenant.id,
    to: phone,
    body: `HeyHenry verification code: ${code}. Expires in 10 minutes.`,
    identity: 'platform',
  });
  if (!sms.ok) return { ok: false, error: sms.error };

  return { ok: true };
}

export async function verifyPhoneAction(input: { code: string }): Promise<VerificationResult> {
  const tenant = await getCurrentTenant();
  const user = await getCurrentUser();
  if (!tenant || !user) return { ok: false, error: 'Not signed in.' };

  const code = input.code.trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: 'Enter the 6-digit code from your text message.' };
  }

  const admin = createAdminClient();

  const { data: row } = await admin
    .from('phone_verification_codes')
    .select('id, phone, code, expires_at, consumed_at, attempts')
    .eq('user_id', user.id)
    .eq('tenant_id', tenant.id)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!row) return { ok: false, error: 'No active code — request a new one.' };
  if (new Date(row.expires_at as string).getTime() < Date.now()) {
    return { ok: false, error: 'Code expired. Request a new one.' };
  }
  if ((row.attempts as number) >= MAX_ATTEMPTS) {
    return { ok: false, error: 'Too many attempts. Request a new code.' };
  }

  if ((row.code as string) !== code) {
    await admin
      .from('phone_verification_codes')
      .update({ attempts: (row.attempts as number) + 1 })
      .eq('id', row.id);
    return { ok: false, error: 'Wrong code. Try again.' };
  }

  // Mark the code consumed and the member's phone verified.
  await admin
    .from('phone_verification_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id);

  const { error: upErr } = await admin
    .from('tenant_members')
    .update({ phone: row.phone, phone_verified_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('tenant_id', tenant.id);
  if (upErr) return { ok: false, error: upErr.message };

  return { ok: true };
}
