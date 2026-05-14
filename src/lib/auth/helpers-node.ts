/**
 * Auth helpers for Node.js HTTP handlers (Pages Router API routes).
 *
 * These mirror `helpers.ts` but accept a raw `IncomingMessage` instead of
 * relying on Next.js's `cookies()` API, which is only available in App Router
 * server context. Used by the Gemini Live WebSocket proxy.
 */

import type { IncomingMessage } from 'node:http';
import { createServerClient } from '@supabase/ssr';
import type { CurrentTenant } from '@/lib/auth/helpers';

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header.split(';').map((c) => {
      const [k, ...v] = c.trim().split('=');
      return [k.trim(), decodeURIComponent(v.join('='))];
    }),
  );
}

/**
 * Resolves the active tenant from a Pages Router API request.
 * Returns null if the request is unauthenticated or has no tenant membership.
 */
export async function getCurrentTenantFromReq(req: IncomingMessage): Promise<CurrentTenant | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const cookieMap = parseCookies(req.headers.cookie);

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return Object.entries(cookieMap).map(([name, value]) => ({ name, value }));
      },
      setAll() {
        // WebSocket upgrade — no response to write cookies into.
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: member } = await supabase
    .from('tenant_members')
    .select(
      'id, role, phone, phone_verified_at, tenants(id, name, slug, timezone, vertical, plan, subscription_status, trial_ends_at, deleted_at)',
    )
    .eq('user_id', user.id)
    .eq('is_active_for_user', true)
    .maybeSingle();

  if (!member?.tenants) return null;

  const tenant = Array.isArray(member.tenants) ? member.tenants[0] : member.tenants;
  if (!tenant) return null;

  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    timezone: (tenant.timezone as string | null) ?? 'America/Vancouver',
    vertical: (tenant.vertical as string | null) ?? 'pressure_washing',
    plan: (tenant.plan ?? 'starter') as CurrentTenant['plan'],
    subscriptionStatus: (tenant.subscription_status ??
      'trialing') as CurrentTenant['subscriptionStatus'],
    trialEndsAt: (tenant.trial_ends_at as string | null) ?? null,
    deletedAt: (tenant.deleted_at as string | null) ?? null,
    member: {
      id: member.id,
      role: member.role,
      phone: (member.phone as string | null) ?? null,
      phone_verified_at: (member.phone_verified_at as string | null) ?? null,
    },
  };
}
