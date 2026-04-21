/**
 * Team member queries.
 *
 * `listTeamMembers` uses the admin client to join auth.users for email
 * addresses (RLS-aware client cannot read auth.users). Tenant isolation
 * is enforced by filtering on tenant_id explicitly.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type TeamMemberRow = {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
  email: string;
  worker_profile?: {
    id: string;
    worker_type: 'employee' | 'subcontractor';
    can_log_expenses: boolean | null;
    can_invoice: boolean | null;
    default_hourly_rate_cents: number | null;
    default_charge_rate_cents: number | null;
    display_name: string | null;
  } | null;
};

/** List all tenant members with their email from auth.users. */
export async function listTeamMembers(tenantId: string): Promise<TeamMemberRow[]> {
  const admin = createAdminClient();

  const { data: members, error } = await admin
    .from('tenant_members')
    .select('id, user_id, role, created_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(error.message);
  if (!members || members.length === 0) return [];

  // Auto-create worker_profiles for any worker-role member that doesn't
  // have one yet. This covers workers who joined before the table existed.
  const workerMemberIds = members.filter((m) => m.role === 'worker').map((m) => m.id);
  if (workerMemberIds.length > 0) {
    const { data: existing } = await admin
      .from('worker_profiles')
      .select('tenant_member_id')
      .in('tenant_member_id', workerMemberIds);
    const existingIds = new Set((existing ?? []).map((p) => p.tenant_member_id as string));
    const missing = workerMemberIds
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ tenant_id: tenantId, tenant_member_id: id }));
    if (missing.length > 0) {
      await admin.from('worker_profiles').insert(missing);
    }
  }

  const { data: profiles } = await admin
    .from('worker_profiles')
    .select(
      'id, tenant_member_id, worker_type, can_log_expenses, can_invoice, default_hourly_rate_cents, default_charge_rate_cents, display_name',
    )
    .eq('tenant_id', tenantId);
  const profilesByMember = new Map((profiles ?? []).map((p) => [p.tenant_member_id as string, p]));

  // Fetch emails from auth.users via admin API.
  const enriched: TeamMemberRow[] = [];
  for (const m of members) {
    const { data } = await admin.auth.admin.getUserById(m.user_id);
    const wp = profilesByMember.get(m.id);
    enriched.push({
      id: m.id,
      user_id: m.user_id,
      role: m.role,
      created_at: m.created_at,
      email: data?.user?.email ?? 'unknown',
      worker_profile: wp
        ? {
            id: wp.id as string,
            worker_type: wp.worker_type as 'employee' | 'subcontractor',
            can_log_expenses: wp.can_log_expenses as boolean | null,
            can_invoice: wp.can_invoice as boolean | null,
            default_hourly_rate_cents: wp.default_hourly_rate_cents as number | null,
            default_charge_rate_cents: wp.default_charge_rate_cents as number | null,
            display_name: wp.display_name as string | null,
          }
        : null,
    });
  }

  return enriched;
}

/**
 * Remove a team member. Deletes the tenant_members row and the auth user.
 * Throws if the member has the 'owner' role (owners cannot be removed).
 */
export async function removeTeamMember(tenantId: string, memberId: string) {
  const admin = createAdminClient();

  // Look up the member to check role and get user_id.
  const { data: member, error: lookupErr } = await admin
    .from('tenant_members')
    .select('id, role, user_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .single();

  if (lookupErr || !member) {
    throw new Error('Member not found.');
  }
  if (member.role === 'owner') {
    throw new Error('Cannot remove the account owner.');
  }

  // Delete tenant_members row.
  const { error: deleteErr } = await admin
    .from('tenant_members')
    .delete()
    .eq('id', memberId)
    .eq('tenant_id', tenantId);

  if (deleteErr) throw new Error(deleteErr.message);

  // Delete the auth user so they can't log in to a dangling account.
  await admin.auth.admin.deleteUser(member.user_id).catch(() => {
    // Best-effort. The member row is gone so they can't access the tenant.
  });
}
