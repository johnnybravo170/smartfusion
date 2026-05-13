/**
 * Audit-log reads for the platform-admin viewer.
 *
 * Uses the service-role admin client because the viewer is a platform-
 * level surface. Operator-side views (if/when we add them) should use the
 * RLS-aware client and rely on the tenant_select_audit_log policy.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export type AuditLogRow = {
  id: string;
  tenantId: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  actorEmail: string | null;
};

export type ListAuditLogFilters = {
  tenantId: string;
  actionPrefix?: string; // e.g. 'invoice.' to filter to all invoice events
  limit?: number;
  before?: string; // ISO created_at — return rows older than this for pagination
};

export async function listAuditLog(filters: ListAuditLogFilters): Promise<AuditLogRow[]> {
  const admin = createAdminClient();
  const limit = Math.min(filters.limit ?? 100, 500);

  let query = admin
    .from('audit_log')
    .select('id, tenant_id, user_id, action, resource_type, resource_id, metadata_json, created_at')
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
    tenant_id: string;
    user_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    metadata_json: Record<string, unknown> | null;
    created_at: string;
  }>;

  // Resolve actor emails in a single batched lookup (auth.users.email).
  const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v)));
  const emailById = new Map<string, string | null>();
  if (userIds.length > 0) {
    // Service role can read auth.users via the admin API.
    for (const uid of userIds) {
      const { data: u } = await admin.auth.admin.getUserById(uid);
      emailById.set(uid, u?.user?.email ?? null);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata_json,
    createdAt: r.created_at,
    actorEmail: r.user_id ? (emailById.get(r.user_id) ?? null) : null,
  }));
}
