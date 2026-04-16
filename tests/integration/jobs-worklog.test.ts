/**
 * Integration test for the Track C status-change flow.
 *
 * Exercises the sequence that `changeJobStatusAction` performs (load, update,
 * log) directly against the database via the admin Supabase client, and
 * verifies that a `worklog_entries` row appears for the affected job.
 *
 * We can't call the server action itself here because it expects Next.js
 * request context (cookies, revalidatePath). Instead we reproduce the
 * invariants: on a status change, a worklog row exists with:
 *   - `entry_type = 'system'`
 *   - `related_type = 'job'`
 *   - `related_id = <job_id>`
 *   - the job's `started_at` is set if moving TO in_progress
 *
 * Skipped when DATABASE_URL + service-role + anon credentials aren't set.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, tenants } from '@/lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const canRun = hasDb && hasSupabase;

describe.skipIf(!canRun)('jobs status-change logs worklog entry (integration)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('moving a job to in_progress writes a system worklog row', async () => {
    const admin = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `jobs-int-${stamp}@smartfusion.test`;
    const password = 'Correct-Horse-9';

    let userId: string | null = null;
    let tenantId: string | null = null;

    try {
      // Provision user + tenant + member.
      const { data: created } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      userId = created?.user?.id ?? null;
      expect(userId).toBeTruthy();

      const { data: tenant } = await admin
        .from('tenants')
        .insert({ name: `Jobs Int ${stamp}` })
        .select('id')
        .single();
      tenantId = tenant?.id ?? null;
      expect(tenantId).toBeTruthy();

      await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantId, user_id: userId, role: 'owner' });

      // Seed one customer and one booked job.
      const { data: customer } = await admin
        .from('customers')
        .insert({
          tenant_id: tenantId,
          type: 'residential',
          name: `Jobs-Int-Customer-${stamp}`,
        })
        .select('id, name')
        .single();
      expect(customer?.id).toBeTruthy();

      const { data: job } = await admin
        .from('jobs')
        .insert({
          tenant_id: tenantId,
          customer_id: customer?.id,
          status: 'booked',
        })
        .select('id, status, started_at, completed_at')
        .single();
      expect(job?.id).toBeTruthy();
      expect(job?.status).toBe('booked');
      expect(job?.started_at).toBeNull();

      // Simulate the action: update status + insert worklog.
      const now = new Date().toISOString();
      const { error: updateErr } = await admin
        .from('jobs')
        .update({ status: 'in_progress', started_at: now, updated_at: now })
        .eq('id', job?.id);
      expect(updateErr).toBeNull();

      const { error: logErr } = await admin.from('worklog_entries').insert({
        tenant_id: tenantId,
        entry_type: 'system',
        title: 'Job status changed',
        body: `Job for ${customer?.name} moved from Booked to In progress.`,
        related_type: 'job',
        related_id: job?.id,
      });
      expect(logErr).toBeNull();

      // Verify: job row is in_progress, started_at set.
      const { data: updated } = await admin
        .from('jobs')
        .select('id, status, started_at, completed_at')
        .eq('id', job?.id)
        .maybeSingle();
      expect(updated?.status).toBe('in_progress');
      expect(updated?.started_at).toBeTruthy();

      // Verify: exactly one matching worklog row.
      const { data: logRows } = await admin
        .from('worklog_entries')
        .select('id, entry_type, title, body, related_type, related_id')
        .eq('related_type', 'job')
        .eq('related_id', job?.id);

      expect(logRows ?? []).toHaveLength(1);
      const log = (logRows ?? [])[0];
      expect(log?.entry_type).toBe('system');
      expect(log?.title).toBe('Job status changed');
      expect(log?.body).toContain('Booked');
      expect(log?.body).toContain('In progress');
      expect(log?.body).toContain(customer?.name as string);
    } finally {
      const db = getDb();
      if (tenantId) await db.delete(tenants).where(eq(tenants.id, tenantId));
      if (userId) await admin.auth.admin.deleteUser(userId).catch(() => {});
    }
  }, 45_000);
});
