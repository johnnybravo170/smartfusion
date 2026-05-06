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
import { newTenantMemberDefaults } from '@/lib/auth/helpers';
import { updateReferralOnSignup } from '@/lib/db/queries/referrals';
import { sendEmail } from '@/lib/email/send';
import { generateReferralCode } from '@/lib/referral/code-generator';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { normalizePhone } from '@/lib/twilio/client';
import { loginSchema, magicLinkSchema, signupSchema } from '@/lib/validators/auth';

export type ActionError = { error: string; fieldErrors?: Record<string, string[]> };

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
  referralCode?: string;
  plan?: string;
  billing?: string;
}): Promise<ActionError | never> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: 'Invalid signup details.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }
  const { email, password, businessName, phone } = parsed.data;

  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    return {
      error:
        'Could not parse phone number — please enter it with country code (e.g. +1 604 555 1234).',
    };
  }

  const admin = createAdminClient();

  // 1. Create the auth user (email NOT auto-confirmed; verification email
  //    is sent below after the tenant rows are in place).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: false,
  });
  if (createErr || !created?.user) {
    const msg = createErr?.message ?? 'Could not create user.';
    // "already been registered" and variants — surface to the user.
    return { error: msg };
  }

  const userId = created.user.id;

  // 2 + 3. Create tenant + tenant_member. Roll back the auth user on failure.
  const { referralCode } = input;
  try {
    // Build tenant insert payload. If a valid referral code was provided,
    // set referred_by_code and extend the trial to 14 days.
    // Default new signups to the renovation (GC) vertical — most inbound
    // tenants are general contractors. TODO: replace with a vertical picker
    // on the signup form.
    const tenantInsert: Record<string, unknown> = { name: businessName, vertical: 'renovation' };
    if (referralCode) {
      tenantInsert.referred_by_code = referralCode;
      tenantInsert.trial_ends_at = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    }

    const { data: tenant, error: tenantErr } = await admin
      .from('tenants')
      .insert(tenantInsert)
      .select('id')
      .single();
    if (tenantErr || !tenant) {
      throw new Error(tenantErr?.message ?? 'Could not create tenant.');
    }

    const { error: memberErr } = await admin.from('tenant_members').insert({
      tenant_id: tenant.id,
      user_id: userId,
      role: 'owner',
      ...(await newTenantMemberDefaults(admin, userId)),
      phone: normalizedPhone,
    });
    if (memberErr) {
      // Tenant row exists but membership failed — delete the tenant too so
      // we don't leak a dangling row. `deleted_at` soft-delete is fine but
      // for this error path a hard delete keeps things tidy.
      await admin.from('tenants').delete().eq('id', tenant.id);
      throw new Error(memberErr.message);
    }

    // Seed default overhead expense categories so /expenses/new isn't a
    // dead-end on first use. Non-fatal — the user can recreate any.
    await admin
      .rpc('seed_default_expense_categories', {
        p_tenant_id: tenant.id,
        p_vertical: 'renovation',
      })
      .then(({ error }) => {
        if (error) console.warn('Failed to seed expense categories:', error.message);
      });

    // Seed default payment sources (Business / Personal / Petty cash) so
    // the receipt forms have something to fall back on before any cards
    // are labeled. Non-fatal.
    await admin
      .rpc('seed_default_payment_sources', { p_tenant_id: tenant.id })
      .then(({ error }) => {
        if (error) console.warn('Failed to seed payment sources:', error.message);
      });

    // Auto-generate a referral code for the new tenant.
    const code = generateReferralCode(businessName);
    const suffix = Math.random().toString(36).slice(2, 6);
    await admin
      .from('referral_codes')
      .insert({ tenant_id: tenant.id, code: `${code}-${suffix}`, type: 'operator' })
      .select('id')
      .single()
      .then(({ error: refErr }) => {
        // Non-fatal: if referral code creation fails, the user can still sign up.
        if (refErr) console.warn('Failed to auto-generate referral code:', refErr.message);
      });

    // If this signup used a referral code, update the referral row.
    if (referralCode) {
      await updateReferralOnSignup(referralCode, tenant.id).catch((err) => {
        console.warn('Failed to update referral on signup:', err);
      });
    }
  } catch (err) {
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

  // 5. Send the email-verification link via Resend (non-fatal — user can
  //    request a re-send from /onboarding/verify if delivery fails).
  await sendVerificationEmail({ email, businessName }).catch((err) => {
    console.warn('Failed to send verification email on signup:', err);
  });

  // Preserve plan/billing choice from marketing-site URL through the
  // verify step so the plan picker can pre-select it.
  const verifyParams = new URLSearchParams();
  if (input.plan) verifyParams.set('plan', input.plan);
  if (input.billing) verifyParams.set('billing', input.billing);
  const qs = verifyParams.toString();
  redirect(qs ? `/onboarding/verify?${qs}` : '/onboarding/verify');
}

async function sendVerificationEmail(input: {
  email: string;
  businessName: string;
}): Promise<void> {
  const admin = createAdminClient();
  const origin = await originFromHeaders();
  // 'magiclink' on an existing unconfirmed user both signs them in and
  // marks email_confirmed_at — exactly what we want for verification.
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: input.email,
    options: { redirectTo: `${origin}/callback?next=/onboarding/verify` },
  });
  if (error || !data?.properties?.action_link) {
    throw new Error(error?.message ?? 'Could not generate verification link.');
  }
  const link = data.properties.action_link;
  await sendEmail({
    to: input.email,
    subject: 'Confirm your HeyHenry email',
    html: `
      <p>Hi,</p>
      <p>Confirm your email to finish setting up <strong>${escapeHtml(input.businessName)}</strong> on HeyHenry:</p>
      <p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0a0a0a;color:#fff;text-decoration:none;border-radius:6px;">Confirm email</a></p>
      <p>Or open this link: <br/><a href="${link}">${link}</a></p>
      <p>This link expires in 24 hours.</p>
    `,
    caslCategory: 'transactional',
    relatedType: 'auth',
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
