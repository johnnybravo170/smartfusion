'use server';

/**
 * Server actions for the referral system (Plan A: owner-to-owner referrals).
 *
 * All actions require auth except where noted. The referral link points at
 * the app domain (app.heyhenry.io/r/{code}) since that's where the
 * (public)/r/[code] landing route is served from. The marketing site at
 * heyhenry.io does not host this route.
 */

import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  createReferral,
  getOrCreateReferralCode,
  getReferralStats as getStats,
  listReferrals,
} from '@/lib/db/queries/referrals';
import { sendEmail } from '@/lib/email/send';
import {
  referralInviteHtml,
  referralInviteSms,
  referralInviteSubject,
} from '@/lib/email/templates/referral-invite';
import { sendSms } from '@/lib/twilio/client';
import { referralEmailSchema, referralSMSSchema } from '@/lib/validators/referral';

const PUBLIC_DOMAIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.heyhenry.io';

export type ReferralActionResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Get the current tenant's referral link + code.
 */
export async function getReferralLinkAction(): Promise<
  ReferralActionResult<{ code: string; url: string }>
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const refCode = await getOrCreateReferralCode(tenant.id, tenant.name);
  return {
    ok: true,
    data: {
      code: refCode.code,
      url: `${PUBLIC_DOMAIN}/r/${refCode.code}`,
    },
  };
}

/**
 * Get referral stats for the current tenant.
 */
export async function getReferralStatsAction(): Promise<
  ReferralActionResult<{ total: number; signed_up: number; converted: number; rewards: number }>
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const stats = await getStats(tenant.id);
  return {
    ok: true,
    data: {
      ...stats,
      rewards: 0, // Placeholder until reward system is built.
    },
  };
}

/**
 * Get referral history for the current tenant.
 */
export async function getReferralHistoryAction(): Promise<
  ReferralActionResult<
    Array<{
      id: string;
      email: string | null;
      phone: string | null;
      status: string;
      created_at: string;
    }>
  >
> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const referrals = await listReferrals(tenant.id);
  return {
    ok: true,
    data: referrals.map((r) => ({
      id: r.id,
      email: r.referred_email,
      phone: r.referred_phone,
      status: r.status,
      created_at: r.created_at,
    })),
  };
}

/**
 * Send a referral invite email and create a pending referral row.
 */
export async function sendReferralEmailAction(
  email: string,
): Promise<ReferralActionResult<{ sent: true }>> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = referralEmailSchema.safeParse({ email });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid email.' };
  }

  const refCode = await getOrCreateReferralCode(tenant.id, tenant.name);
  const referralUrl = `${PUBLIC_DOMAIN}/r/${refCode.code}`;

  // Create the pending referral row.
  await createReferral({
    referral_code_id: refCode.id,
    referrer_tenant_id: tenant.id,
    referred_email: parsed.data.email,
  });

  // Send the email.
  const result = await sendEmail({
    tenantId: tenant.id,
    to: parsed.data.email,
    subject: referralInviteSubject(tenant.name),
    html: referralInviteHtml({
      referrerName: tenant.name,
      referralUrl,
    }),
    // Referrer-initiated invitation. Implied consent under CASL personal-relationship
    // exemption (referrer + referee are real-world contacts). Phase B: capture
    // referrer attestation at submit time so this is auditable.
    caslCategory: 'response_to_request',
    relatedType: 'referral',
    relatedId: refCode.id,
    caslEvidence: {
      kind: 'referral_invite',
      referralCodeId: refCode.id,
      referrerTenantId: tenant.id,
    },
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Failed to send email.' };
  }

  return { ok: true, data: { sent: true } };
}

/**
 * Send a referral invite SMS and create a pending referral row.
 *
 * Mirrors `sendReferralEmailAction` — see its CASL note. The referrer
 * attests a personal-relationship (CASL implied-consent exemption);
 * Phase B should capture an explicit attestation at submit time.
 */
export async function sendReferralSMSAction(
  phone: string,
): Promise<ReferralActionResult<{ sent: true }>> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const parsed = referralSMSSchema.safeParse({ phone });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid phone number.' };
  }

  const refCode = await getOrCreateReferralCode(tenant.id, tenant.name);
  const referralUrl = `${PUBLIC_DOMAIN}/r/${refCode.code}`;

  await createReferral({
    referral_code_id: refCode.id,
    referrer_tenant_id: tenant.id,
    referred_phone: parsed.data.phone,
  });

  const result = await sendSms({
    tenantId: tenant.id,
    to: parsed.data.phone,
    body: referralInviteSms({ referrerName: tenant.name, referralUrl }),
    relatedType: 'referral',
    relatedId: refCode.id,
    caslCategory: 'response_to_request',
    caslEvidence: {
      kind: 'referral_invite',
      referralCodeId: refCode.id,
      referrerTenantId: tenant.id,
    },
  });

  if (!result.ok) {
    return { ok: false, error: result.error ?? 'Failed to send SMS.' };
  }

  return { ok: true, data: { sent: true } };
}
