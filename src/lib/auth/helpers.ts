/**
 * Auth helpers for server components, server actions, and route handlers.
 *
 * `getCurrentTenant()` looks up the tenant through `tenant_members` — the
 * source of truth per §13.1 of PHASE_1_PLAN.md. Do NOT trust a JWT claim
 * for tenant resolution; removing a member must revoke access immediately,
 * not on token refresh.
 */

import * as Sentry from '@sentry/nextjs';
import { redirect } from 'next/navigation';
import { cache } from 'react';
import type { Plan, SubscriptionStatus } from '@/lib/billing/features';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

/**
 * Per-request memoised. Page shell + multiple tab server components often
 * need the current user in the same render; cache() coalesces them.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

export type CurrentTenant = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  vertical: string;
  plan: Plan;
  subscriptionStatus: SubscriptionStatus;
  trialEndsAt: string | null;
  member: {
    id: string;
    role: string;
    phone: string | null;
    phone_verified_at: string | null;
  };
};

/**
 * Resolves the current user's tenant via `tenant_members`. Returns `null`
 * when the user is unauthenticated or has no tenant. Runs under RLS, so
 * returning a row implies the user is allowed to see it.
 *
 * Wrapped in React.cache below so repeated calls within one render dedupe.
 */
async function getCurrentTenantUncached(): Promise<CurrentTenant | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from('tenant_members')
    .select(
      'id, role, phone, phone_verified_at, tenants(id, name, slug, timezone, vertical, plan, subscription_status, trial_ends_at)',
    )
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member?.tenants) return null;

  // Supabase typings return `tenants` as an array for one-to-many joins
  // and an object for one-to-one. We declared a scalar FK so it's an
  // object at runtime, but TS is conservative here.
  const tenant = Array.isArray(member.tenants) ? member.tenants[0] : member.tenants;
  if (!tenant) return null;

  // Tag every server-side error with tenant + user UUIDs (no PII per
  // PIPEDA — names/emails are scrubbed by sentry/scrub.ts).
  Sentry.setUser({ id: user.id });
  Sentry.setTag('tenant_id', tenant.id);
  Sentry.setTag('tenant_plan', (tenant.plan ?? 'starter') as string);
  Sentry.setTag('tenant_vertical', (tenant.vertical ?? 'pressure_washing') as string);

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    timezone: tenant.timezone ?? 'America/Vancouver',
    vertical: tenant.vertical ?? 'pressure_washing',
    plan: (tenant.plan ?? 'starter') as Plan,
    subscriptionStatus: (tenant.subscription_status ?? 'trialing') as SubscriptionStatus,
    trialEndsAt: (tenant.trial_ends_at as string | null) ?? null,
    member: {
      id: member.id,
      role: member.role,
      phone: (member.phone as string | null) ?? null,
      phone_verified_at: (member.phone_verified_at as string | null) ?? null,
    },
  };
}

export const getCurrentTenant = cache(getCurrentTenantUncached);

/**
 * Redirects to `/login` if the user is not authenticated, otherwise returns
 * the Supabase auth user. Use from server components that render inside a
 * protected route.
 */
export async function requireAuth() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Redirects to `/login` if unauthenticated and to `/signup?error=no_tenant`
 * if authenticated but orphaned (no tenant_members row).
 */
export async function requireTenant() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/signup?error=no_tenant');
  return { user, tenant };
}

/**
 * Guard for the /w worker surface. Redirects non-workers to /dashboard.
 * (The proxy already does this, but pages should also guard so a bad
 * link from a different role doesn't render a broken shell.)
 */
export async function requireWorker() {
  const { user, tenant } = await requireTenant();
  if (tenant.member.role !== 'worker') redirect('/dashboard');
  return { user, tenant };
}

/**
 * Guard for the /bk bookkeeper surface. Bookkeepers see a scoped view
 * into the tenant's financial surfaces — expenses, bills, invoices,
 * GST remittance, T4A roll-ups, year-end exports. They do NOT see
 * customer PII, project details, or operational content.
 *
 * Owners/admins also pass the guard (useful for testing + so Jonathan
 * can demo the bookkeeper experience without logging out). Pure
 * workers bounce to /w.
 */
export async function requireBookkeeper() {
  const { user, tenant } = await requireTenant();
  const role = tenant.member.role;
  if (role === 'worker') redirect('/w');
  // Anyone else gets through. The /bk UI is safe to show an owner.
  return { user, tenant };
}

// ---------------------------------------------------------------------------
// Platform admin helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the user is a platform admin (Hey Henry staff). Uses the
 * service-role client so the row check isn't affected by whatever tenant
 * the user belongs to.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  if (!userId) return false;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userId)
    .maybeSingle();
  return !!data;
}

/**
 * Redirects non-admins away from admin-only surfaces. Unauthenticated
 * users go to /login; authenticated non-admins go to /dashboard.
 */
export async function requirePlatformAdmin() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const admin = await isPlatformAdmin(user.id);
  if (!admin) redirect('/dashboard');
  return user;
}
