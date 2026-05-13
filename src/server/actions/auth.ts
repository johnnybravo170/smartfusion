'use server';

/**
 * Auth server actions: signup, login, magic link, logout.
 *
 * Signup is the bootstrap path for multi-tenancy. We create the auth user,
 * tenant row, and tenant_member row inside a single action. The admin
 * client is used because the user doesn't yet have a session — RLS would
 * reject the inserts otherwise. If the tenant or member insert fails we
 * roll back the auth user to avoid orphaned auth.users rows.
 *
 * See §13.1 and §8 Task 1.6 of PHASE_1_PLAN.md.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { updateReferralOnSignup } from '@/lib/db/queries/referrals';
import { sendWelcomeEmail } from '@/lib/email/welcome';
import { CURRENT_PRIVACY_VERSION, CURRENT_TOS_VERSION } from '@/lib/legal/versions';
import { callerIp, checkRateLimit, describeRetryAfter } from '@/lib/rate-limit';
import { generateReferralCode } from '@/lib/referral/code-generator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { normalizePhone } from '@/lib/twilio/client';
import { loginSchema, magicLinkSchema, signupSchema } from '@/lib/validators/auth';

export type ActionError = {
  error: string;
  fieldErrors?: Record<string, string[]>;
  code?: 'EMAIL_ALREADY_REGISTERED';
};

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

export async function signupAction(input: {
  email: string;
  password: string;
  businessName: string;
  phone: string;
  acceptedPolicies: boolean;
  referralCode?: string;
  plan?: string;
  billing?: string;
  promo?: string;
}): Promise<ActionError | never> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: 'Invalid signup details.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { email, password, businessName, phone } = parsed.data;

  // Rate limit: per-IP (burst control) + per-email (account-enumeration
  // control). Enforce IP first so an attacker can't cycle emails to map
  // existence quickly.
  const ip = await callerIp();
  const ipLimit = await checkRateLimit(`signup:ip:${ip}`, {
    limit: 5,
    windowMs: 10 * 60_000,
  });
  if (!ipLimit.ok) {
    return {
      error: `Too many signup attempts. Try again in ${describeRetryAfter(ipLimit.retryAfterMs)}.`,
    };
  }
  const emailLimit = await checkRateLimit(`signup:email:${email}`, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  if (!emailLimit.ok) {
    return {
      error: `Too many attempts for this email. Try again in ${describeRetryAfter(emailLimit.retryAfterMs)}.`,
    };
  }

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return {
      error:
        'Could not parse phone number — please enter it with country code (e.g. +1 604 555 1234).',
    };
  }

  const admin = createAdminClient();

  // 1. Create the auth user, already-confirmed. We don't gate product access
  //    on email verification — bounces are handled separately. See
  //    docs/onboarding-audit-2026-05.md.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'Could not create user.';
    // Detect "already registered" so the form can show a recovery path
    // (sign-in link with email pre-filled) instead of a dead-end error.
    const lower = msg.toLowerCase();
    const code = (createErr as { code?: string } | null)?.code;
    if (
      code === 'email_exists' ||
      code === 'user_already_exists' ||
      (lower.includes('already') && lower.includes('regist'))
    ) {
      return {
        error: 'An account with this email already exists.',
        code: 'EMAIL_ALREADY_REGISTERED',
      };
    }
    return { error: msg };
  }

  const userId = created.user.id;
  let createdTenantId: string | null = null;

  // 2 + 3 + 4 + seeds + referral_code in ONE Postgres transaction via
  // signup_tenant() RPC. If any step inside fails, the whole block rolls
  // back automatically — no half-set-up tenant rows. The auth.user stays
  // outside (it's in the auth schema, managed by Supabase Auth) so the
  // only compensating action we still need is deleting it on RPC error.
  const { referralCode } = input;
  const referralCodeBase = generateReferralCode(businessName);
  const referralCodeSuffix = Math.random().toString(36).slice(2, 6);
  const newReferralCode = `${referralCodeBase}-${referralCodeSuffix}`;
  const acceptedAt = new Date().toISOString();

  try {
    const { data: tenantId, error: rpcErr } = await admin.rpc('signup_tenant', {
      p_user_id: userId,
      p_business_name: businessName,
      p_vertical: 'renovation',
      p_phone: normalizedPhone,
      p_tos_version: CURRENT_TOS_VERSION,
      p_privacy_version: CURRENT_PRIVACY_VERSION,
      p_accepted_at: acceptedAt,
      p_referral_code: newReferralCode,
      p_referred_by_code: referralCode ?? null,
    });
    if (rpcErr || !tenantId) {
      throw new Error(rpcErr?.message ?? 'Could not create tenant.');
    }
    createdTenantId = tenantId as string;

    // Side-effect outside the transaction: update the inbound referral
    // row (best-effort — failure here doesn't undo the signup).
    if (referralCode) {
      await updateReferralOnSignup(referralCode, createdTenantId).catch((err) => {
        console.warn('Failed to update referral on signup:', err);
      });
    }
  } catch (err) {
    // The Postgres transaction already rolled back the tenant/member/
    // referral_code rows. Delete the auth user so the email can be
    // re-used on a retry without hitting "already registered".
    await admin.auth.admin.deleteUser(userId).catch(() => {
      // Nothing we can do if the rollback fails. The dangling auth user
      // can be cleaned up manually.
    });
    const msg = err instanceof Error ? err.message : 'Signup failed.';
    return { error: msg };
  }

  // 4. Sign the user in with the regular client so cookies are set.
  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) {
    return { error: `Account created but sign-in failed: ${signInErr.message}` };
  }

  // 5. Welcome email signed by Jonathan — fills the silence after signup.
  // Idempotent on tenants.welcome_email_sent_at; non-fatal on send failure.
  if (createdTenantId) {
    await sendWelcomeEmail(createdTenantId).catch((err) => {
      console.warn('Welcome email send failed:', err);
    });
  }

  // If the customer arrived from a paid-plan CTA on the marketing site,
  // route them through the plan picker → Stripe Checkout. Otherwise drop
  // them straight into the dashboard — zero-friction trial.
  const wantsCheckout = Boolean(input.plan && input.billing);
  if (wantsCheckout) {
    const qs = new URLSearchParams();
    if (input.plan) qs.set('plan', input.plan);
    if (input.billing) qs.set('billing', input.billing);
    if (input.promo) qs.set('promo', input.promo);
    redirect(`/onboarding/plan?${qs.toString()}`);
  }
  redirect('/dashboard');
}

export async function loginAction(input: {
  email: string;
  password: string;
  next?: string;
}): Promise<ActionError | never> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: 'Invalid login details.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { email, password } = parsed.data;

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  // If the user has a verified MFA factor, the session is aal1 and we need
  // to complete an MFA challenge before letting them into the app.
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.nextLevel === 'aal2' && aal.currentLevel === 'aal1') {
    redirect('/login/mfa');
  }

  // Honor ?next= when present (email link → login → original page).
  // Only same-origin paths; reject protocol-relative or external.
  const requestedNext = input.next;
  const safeNext =
    requestedNext?.startsWith('/') && !requestedNext.startsWith('//') ? requestedNext : null;
  if (safeNext) redirect(safeNext);

  // Role-aware destination: workers → /w, bookkeepers → /bk, else /dashboard.
  // Uses admin client because the session cookie isn't attached to the
  // server client yet after signInWithPassword.
  redirect(await destinationForCurrentUser());
}

/**
 * Resolve the post-login destination based on the signed-in user's
 * tenant_members.role for their currently-active membership.
 */
async function destinationForCurrentUser(): Promise<string> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return '/dashboard';
  const admin = createAdminClient();
  const { data: member } = await admin
    .from('tenant_members')
    .select('role')
    .eq('user_id', user.id)
    .eq('is_active_for_user', true)
    .maybeSingle();
  const role = (member?.role as string | null) ?? null;
  if (role === 'worker') return '/w';
  if (role === 'bookkeeper') return '/bk';
  return '/dashboard';
}

export async function requestMagicLinkAction(input: {
  email: string;
}): Promise<ActionError | { success: true; email: string } | never> {
  const parsed = magicLinkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: 'Invalid email.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { email } = parsed.data;

  // Rate limit: per-IP (burst) + per-email (enumeration). Magic-link
  // success/failure response is uniform regardless of whether the email
  // exists, but without throttling an attacker can probe many emails fast.
  const ip = await callerIp();
  const ipLimit = await checkRateLimit(`magic:ip:${ip}`, {
    limit: 10,
    windowMs: 10 * 60_000,
  });
  if (!ipLimit.ok) {
    return {
      error: `Too many requests. Try again in ${describeRetryAfter(ipLimit.retryAfterMs)}.`,
    };
  }
  const emailLimit = await checkRateLimit(`magic:email:${email}`, {
    limit: 5,
    windowMs: 60 * 60_000,
  });
  if (!emailLimit.ok) {
    return {
      error: `Too many magic-link requests for this email. Try again in ${describeRetryAfter(emailLimit.retryAfterMs)}.`,
    };
  }

  const origin = await originFromHeaders();
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      // Only existing users; magic-link signup is deferred to Phase 2.
      shouldCreateUser: false,
      emailRedirectTo: `${origin}/callback`,
    },
  });
  if (error) {
    return { error: error.message };
  }

  return { success: true, email };
}

export async function logoutAction(): Promise<never> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
