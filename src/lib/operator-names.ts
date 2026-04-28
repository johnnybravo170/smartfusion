/**
 * Resolve auth user_ids → human-readable display names for operators
 * (owner/admin/crew-not-in-worker_profiles). Pulls first/last from
 * tenant_members and falls back to the local part of their auth email.
 *
 * Returns a Map<userId, displayName>. Callers use it to label time entries,
 * expenses, comments, etc. so the UI never has to fall back to a generic
 * "Owner/admin" string when we actually know the person's name.
 *
 * Used by CostsTabServer + TimeTabServer; extract more callers as needed.
 */
import { createAdminClient } from '@/lib/supabase/admin';

export function composeOperatorName(params: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  email: string | null | undefined;
}): string | undefined {
  const first = params.firstName?.trim();
  const last = params.lastName?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  if (last) return last;
  if (params.email) {
    const local = params.email.split('@')[0];
    if (local) return local;
  }
  return undefined;
}

export async function getOperatorNamesForTenant(tenantId: string): Promise<Map<string, string>> {
  const admin = createAdminClient();
  const { data: tenantMembers } = await admin
    .from('tenant_members')
    .select('user_id, first_name, last_name')
    .eq('tenant_id', tenantId);

  const memberUserIds = Array.from(
    new Set((tenantMembers ?? []).map((m) => m.user_id as string).filter(Boolean)),
  );
  // Direct getUserById per user (was: listUsers({perPage:200})). The paginated
  // call missed users beyond the first page on bigger tenants — JVD's owner
  // entries were falling through to "Owner/admin" because his auth user was
  // outside the page window. Direct lookups are O(N members) but N is small.
  const emailByUserId = new Map<string, string>();
  await Promise.all(
    memberUserIds.map(async (uid) => {
      const { data } = await admin.auth.admin.getUserById(uid);
      if (data?.user?.email) emailByUserId.set(uid, data.user.email);
    }),
  );

  const out = new Map<string, string>();
  for (const m of tenantMembers ?? []) {
    const name = composeOperatorName({
      firstName: m.first_name as string | null,
      lastName: m.last_name as string | null,
      email: emailByUserId.get(m.user_id as string),
    });
    if (name) out.set(m.user_id as string, name);
  }
  return out;
}
