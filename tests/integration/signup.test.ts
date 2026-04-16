/**
 * Integration test for the signup path.
 *
 * Calls the admin-client steps of the signup action directly (auth user +
 * tenant + tenant_member insert) against the local or remote database
 * indicated by DATABASE_URL. Skipped when the DB isn't reachable.
 *
 * We can't call `signupAction` itself here because it expects a Next.js
 * request context (for cookies + redirect). Instead we exercise the
 * exact sequence of admin-client calls the action performs and assert
 * the same invariants: auth user row + tenant row + tenant_member row
 * with role=owner, all linked.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, tenantMembers, tenants } from '@/lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const canRun = hasDb && hasSupabase;

describe.skipIf(!canRun)('signup flow (integration)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('creates an auth user, tenant, and tenant_member in one flow', async () => {
    const admin = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const email = `integration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@smartfusion.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Integration Co ${Date.now()}`;

    let userId: string | null = null;
    let tenantId: string | null = null;

    try {
      // Step 1: create auth user.
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      expect(createErr).toBeNull();
      const newUserId = created?.user?.id;
      expect(newUserId).toBeTruthy();
      userId = newUserId as string;

      // Step 2: tenant.
      const { data: tenant, error: tenantErr } = await admin
        .from('tenants')
        .insert({ name: businessName })
        .select('id, name')
        .single();
      expect(tenantErr).toBeNull();
      expect(tenant?.id).toBeTruthy();
      tenantId = tenant?.id ?? null;
      expect(tenant?.name).toBe(businessName);

      // Step 3: tenant_member.
      const { error: memberErr } = await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantId, user_id: userId, role: 'owner' });
      expect(memberErr).toBeNull();

      // Assert via Drizzle that the rows exist as expected.
      const db = getDb();
      const tid = tenantId as string;
      const tenantRows = await db.select().from(tenants).where(eq(tenants.id, tid));
      expect(tenantRows).toHaveLength(1);
      expect(tenantRows[0].name).toBe(businessName);

      const memberRows = await db
        .select()
        .from(tenantMembers)
        .where(eq(tenantMembers.tenantId, tid));
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0].userId).toBe(userId);
      expect(memberRows[0].role).toBe('owner');
    } finally {
      // Cleanup: tenant CASCADE deletes tenant_members, then delete the
      // auth user.
      if (tenantId) {
        const db = getDb();
        await db.delete(tenants).where(eq(tenants.id, tenantId));
      }
      if (userId) {
        await admin.auth.admin.deleteUser(userId).catch(() => {});
      }
    }
  }, 30_000);
});
