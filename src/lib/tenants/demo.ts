/**
 * QA / demo tenant guardrails.
 *
 * Tenants flagged `is_demo = true` are internal QA accounts (see
 * docs/qa-tenant.md). Two things key off the flag:
 *   1. Outbound email + SMS is suppressed — logged with status
 *      `suppressed_demo` but never handed to Postmark / Twilio, so test
 *      invoices and estimates can't reach real inboxes or phones.
 *   2. Platform metrics exclude them so QA activity doesn't pollute
 *      signup / revenue / SMS counts.
 *
 * Both reads go through the service-role client — callers are pipeline
 * code (send paths, admin metrics) that already run outside RLS.
 */

import { cache } from 'react';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * True when the tenant is an internal QA / demo account. A null/undefined
 * tenantId (platform-level auth mail, etc.) is never demo.
 */
export async function isDemoTenant(tenantId: string | null | undefined): Promise<boolean> {
  if (!tenantId) return false;
  const admin = createAdminClient();
  const { data } = await admin.from('tenants').select('is_demo').eq('id', tenantId).maybeSingle();
  return !!data?.is_demo;
}

/**
 * IDs of every demo tenant. Used by cross-tenant metrics queries to filter
 * QA accounts out of platform aggregates. The set stays tiny (a handful of
 * QA tenants ever), so callers can splice the result straight into a
 * `.not('tenant_id', 'in', ...)` filter without worrying about size.
 *
 * `cache()`-wrapped so the admin metrics page — which fans out into a dozen
 * cross-tenant queries — resolves the demo list once per request.
 */
export const getDemoTenantIds = cache(async (): Promise<string[]> => {
  const admin = createAdminClient();
  const { data } = await admin.from('tenants').select('id').eq('is_demo', true);
  return (data ?? []).map((r) => r.id as string);
});

/**
 * PostgREST `in` list literal — `(id1,id2)` — or null when there are no
 * demo tenants. Pattern at call sites:
 *
 *   const exclude = demoExclusionList(await getDemoTenantIds());
 *   let q = admin.from('jobs').select('tenant_id');
 *   if (exclude) q = q.not('tenant_id', 'in', exclude);
 */
export function demoExclusionList(ids: string[]): string | null {
  if (ids.length === 0) return null;
  return `(${ids.join(',')})`;
}
