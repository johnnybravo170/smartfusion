/**
 * Auth helpers for server components, server actions, and route handlers.
 *
 * `getCurrentTenant()` looks up the tenant through `tenant_members` — the
 * source of truth per §13.1 of PHASE_1_PLAN.md. Do NOT trust a JWT claim
 * for tenant resolution; removing a member must revoke access immediately,
 * not on token refresh.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

export async function getCurrentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export type CurrentTenant = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  member: {
    id: string;
    role: string;
  };
};

/**
 * Resolves the current user's tenant via `tenant_members`. Returns `null`
 * when the user is unauthenticated or has no tenant. Runs under RLS, so
 * returning a row implies the user is allowed to see it.
 */
export async function getCurrentTenant(): Promise<CurrentTenant | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from('tenant_members')
    .select('id, role, tenants(id, name, slug, timezone)')
    .eq('user_id', user.id)
    .maybeSingle();

  if (!member?.tenants) return null;

  // Supabase typings return `tenants` as an array for one-to-many joins
  // and an object for one-to-one. We declared a scalar FK so it's an
  // object at runtime, but TS is conservative here.
  const tenant = Array.isArray(member.tenants) ? member.tenants[0] : member.tenants;
  if (!tenant) return null;

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    timezone: tenant.timezone ?? 'America/Vancouver',
    member: { id: member.id, role: member.role },
  };
}

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
