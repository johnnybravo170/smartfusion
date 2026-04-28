/**
 * List every tenant the given user belongs to, with the tenant cosmetics
 * needed by the workspace switcher (name, accent_color, is_demo) plus
 * the active-membership flag.
 *
 * Uses the admin client because RLS on tenants/tenant_members scopes to
 * `current_tenant_id()` — which now returns only the *active* tenant, so
 * a regular client can't see a user's non-active memberships.
 *
 * Safe because we filter strictly by the passed userId.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type UserMembership = {
  tenantMemberId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string | null;
  accentColor: string | null;
  isDemo: boolean;
  isActive: boolean;
  role: string;
};

export async function listUserMemberships(userId: string): Promise<UserMembership[]> {
  if (!userId) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('tenant_members')
    .select(
      'id, role, is_active_for_user, tenants(id, name, slug, accent_color, is_demo, created_at)',
    )
    .eq('user_id', userId);
  if (error || !data) return [];

  type Row = {
    id: string;
    role: string;
    is_active_for_user: boolean | null;
    tenants:
      | {
          id: string;
          name: string;
          slug: string | null;
          accent_color: string | null;
          is_demo: boolean | null;
          created_at: string;
        }
      | Array<{
          id: string;
          name: string;
          slug: string | null;
          accent_color: string | null;
          is_demo: boolean | null;
          created_at: string;
        }>
      | null;
  };

  const rows = data as unknown as Row[];
  return rows
    .map((row) => {
      const t = Array.isArray(row.tenants) ? row.tenants[0] : row.tenants;
      if (!t) return null;
      return {
        tenantMemberId: row.id,
        tenantId: t.id,
        tenantName: t.name,
        tenantSlug: t.slug,
        accentColor: t.accent_color,
        isDemo: !!t.is_demo,
        isActive: !!row.is_active_for_user,
        role: row.role,
      } satisfies UserMembership;
    })
    .filter((m): m is UserMembership => m !== null)
    .sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.tenantName.localeCompare(b.tenantName);
    });
}
