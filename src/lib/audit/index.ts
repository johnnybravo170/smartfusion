/**
 * Append-only audit trail writer.
 *
 * One canonical helper that every sensitive server action calls. The
 * `audit_log` table is RLS-protected so authenticated callers can write
 * only for their own tenant; we use the admin client to bypass that
 * uniformly (the tenantId is passed in by the caller, who has already
 * verified ownership via getCurrentTenant or similar).
 *
 * Failures are LOGGED, never raised. Audit logging must not break the
 * underlying business action — losing one audit row is better than
 * failing a customer-facing mutation.
 *
 * Naming convention for `action`: `<resource_type>.<verb>`, snake_case
 * verb, e.g. `invoice.created`, `team.member_removed`, `mfa.disabled`,
 * `stripe.connected`. This is grep-friendly, sorts nicely, and lets us
 * filter prefix-wise in the admin viewer.
 */

import { headers } from 'next/headers';
import { createAdminClient } from '@/lib/supabase/admin';

export type AuditInput = {
  tenantId: string;
  /** Null for system / webhook / cron-emitted events. */
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  /** Free-form. Avoid PII / secrets; this is queryable by anyone with
   *  read access to the tenant's audit trail. */
  metadata?: Record<string, unknown> | null;
};

export async function audit(input: AuditInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const meta = await enrichMetadata(input.metadata);
    const { error } = await admin.from('audit_log').insert({
      tenant_id: input.tenantId,
      user_id: input.userId,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId ?? null,
      metadata_json: meta,
    });
    if (error) {
      console.warn(`[audit] failed to log ${input.action}: ${error.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[audit] failed to log ${input.action}: ${msg}`);
  }
}

/**
 * Add request context (IP, user agent) to caller-supplied metadata when
 * we're inside a request handler. Best-effort — `headers()` throws when
 * called outside a request scope (e.g. cron), in which case we just
 * return the caller's metadata as-is.
 */
async function enrichMetadata(
  meta: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown> | null> {
  let ip: string | null = null;
  let userAgent: string | null = null;
  try {
    const h = await headers();
    const xff = h.get('x-forwarded-for');
    ip = xff ? (xff.split(',')[0]?.trim() ?? null) : (h.get('x-real-ip') ?? null);
    userAgent = h.get('user-agent');
  } catch {
    // Outside a request scope — fine, just don't enrich.
  }
  const ctx: Record<string, unknown> = {};
  if (ip) ctx.ip = ip;
  if (userAgent) ctx.user_agent = userAgent;
  if (Object.keys(ctx).length === 0 && !meta) return null;
  return { ...(meta ?? {}), ...(Object.keys(ctx).length > 0 ? { _ctx: ctx } : {}) };
}
