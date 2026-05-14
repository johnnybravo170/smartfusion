/**
 * Operator-facing audit-log reads.
 *
 * Uses the RLS-aware server client so the tenant filter is implicit
 * (the tenant_select_audit_log policy enforces it). Resolves actor
 * names from tenant_members joined to auth.users so operators see
 * "Will Verbeek" instead of a UUID. Members of OTHER tenants the
 * actor also belongs to are scrubbed to "another team member" — we
 * don't leak cross-tenant identity.
 *
 * If you need cross-tenant data for the platform-admin viewer, use
 * src/lib/db/queries/audit-log.ts instead.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export type TenantAuditLogRow = {
  id: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  /** Resolved name for display. "System" for null userId, the member's
   *  email if they belong to this tenant, or "another team member" for
   *  the rare case where a user_id is recorded but no longer a member. */
  actorLabel: string;
};

export type ListTenantAuditLogFilters = {
  tenantId: string;
  actionPrefix?: string;
  limit?: number;
  before?: string;
};

export async function listTenantAuditLog(
  filters: ListTenantAuditLogFilters,
): Promise<TenantAuditLogRow[]> {
  const supabase = await createClient();
  const limit = Math.min(filters.limit ?? 100, 500);

  let query = supabase
    .from('audit_log')
    .select('id, user_id, action, resource_type, resource_id, metadata_json, created_at')
    .eq('tenant_id', filters.tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filters.actionPrefix) {
    query = query.like('action', `${filters.actionPrefix}%`);
  }
  if (filters.before) {
    query = query.lt('created_at', filters.before);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load audit log: ${error.message}`);

  const rows = (data ?? []) as Array<{
    id: string;
    user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata_json: Record<string, unknown> | null;
    created_at: string;
  }>;

  // Resolve actor labels. We need auth.users.email for the actor user IDs
  // — that lookup needs the admin client. We restrict the lookup to user
  // IDs that belong to this tenant (any other id gets "another team
  // member"), so we never leak identity across tenants.
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v)));
  const memberEmailById = new Map<string, string>();
  if (userIds.length > 0) {
    const admin = createAdminClient();
    const { data: members } = await admin
      .from('tenant_members')
      .select('user_id')
      .eq('tenant_id', filters.tenantId)
      .in('user_id', userIds);

    const tenantUserIds = new Set((members ?? []).map((m) => m.user_id as string));
    for (const uid of tenantUserIds) {
      const { data: u } = await admin.auth.admin.getUserById(uid);
      if (u?.user?.email) memberEmailById.set(uid, u.user.email);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata_json,
    createdAt: r.created_at,
    actorLabel: !r.user_id ? 'System' : (memberEmailById.get(r.user_id) ?? 'Another team member'),
  }));
}
