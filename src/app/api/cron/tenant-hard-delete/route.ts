/**
 * GET /api/cron/tenant-hard-delete
 *
 * Daily cron — purges tenants whose 30-day soft-delete window has
 * passed. The flow:
 *
 *   1. Find rows in tenant_deletion_requests where aborted_at IS NULL
 *      and effective_at < now().
 *   2. For each, write a tenant_hard_delete_log row (this survives the
 *      cascade so we keep proof the deletion happened).
 *   3. DELETE the tenants row. ON DELETE CASCADE on every tenant-scoped
 *      table reaches the rest. The deletion request row, the audit_log,
 *      photos, customers, invoices — everything goes.
 *
 * Auth: Bearer ${CRON_SECRET}, same as the other cron routes.
 *
 * Idempotent on re-run: a second invocation finds zero eligible rows
 * (the first run cascaded the deletion requests away).
 *
 * Vercel cron entry: see vercel.json — daily 04:00 UTC (~9 PM PT).
 */

import { reportError } from '@/lib/error-reporting';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

type EligibleRequest = {
  id: string;
  tenant_id: string;
  requested_by_user_id: string;
  requested_at: string;
  effective_at: string;
};

export async function GET(request: Request) {
  const auth = request.headers.get('authorization');
  const expected = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const now = new Date().toISOString();

  // Eligibility: not aborted, effective date has passed, AND the tenant is
  // still soft-deleted (defense in depth — if someone manually cleared
  // tenants.deleted_at outside the abort flow, we don't purge their data).
  const { data: eligible, error: queryErr } = await admin
    .from('tenant_deletion_requests')
    .select('id, tenant_id, requested_by_user_id, requested_at, effective_at')
    .is('aborted_at', null)
    .lt('effective_at', now);

  if (queryErr) {
    reportError(queryErr, { task: 'tenant-hard-delete', stage: 'query' });
    return Response.json({ error: queryErr.message }, { status: 500 });
  }

  const requests = (eligible ?? []) as EligibleRequest[];
  if (requests.length === 0) {
    return Response.json({ ok: true, eligible: 0, purged: 0 });
  }

  // Filter to tenants that are actually still soft-deleted. One round-trip
  // for the batch instead of one per request.
  const tenantIds = requests.map((r) => r.tenant_id);
  const { data: tenants, error: tenantsErr } = await admin
    .from('tenants')
    .select('id, name, deleted_at')
    .in('id', tenantIds);

  if (tenantsErr) {
    reportError(tenantsErr, { task: 'tenant-hard-delete', stage: 'tenant-fetch' });
    return Response.json({ error: tenantsErr.message }, { status: 500 });
  }

  const stillDeleted = new Map<string, { name: string }>(
    (tenants ?? [])
      .filter((t) => (t.deleted_at as string | null) !== null)
      .map((t) => [t.id as string, { name: (t.name as string | null) ?? '' }]),
  );

  let purged = 0;
  let skipped = 0;
  const errors: Array<{ tenant_id: string; error: string }> = [];

  for (const req of requests) {
    const tenant = stillDeleted.get(req.tenant_id);
    if (!tenant) {
      // Either tenant already hard-deleted or has been restored outside the
      // abort flow. Skip.
      skipped += 1;
      continue;
    }

    // Write the audit ledger BEFORE the delete cascade kills our ability to.
    const { error: logErr } = await admin.from('tenant_hard_delete_log').insert({
      tenant_id: req.tenant_id,
      tenant_name: tenant.name,
      deletion_request_id: req.id,
      requested_by_user_id: req.requested_by_user_id,
      requested_at: req.requested_at,
      effective_at: req.effective_at,
    });
    if (logErr) {
      reportError(logErr, { task: 'tenant-hard-delete', tenantId: req.tenant_id });
      errors.push({ tenant_id: req.tenant_id, error: logErr.message });
      continue;
    }

    // Now purge. FK ON DELETE CASCADE reaches every tenant-scoped table.
    const { error: delErr } = await admin.from('tenants').delete().eq('id', req.tenant_id);
    if (delErr) {
      reportError(delErr, { task: 'tenant-hard-delete', tenantId: req.tenant_id });
      errors.push({ tenant_id: req.tenant_id, error: delErr.message });
      continue;
    }

    purged += 1;
  }

  return Response.json({
    ok: errors.length === 0,
    eligible: requests.length,
    purged,
    skipped,
    errors,
  });
}
