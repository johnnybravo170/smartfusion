/**
 * Integration test: cross-tenant RLS isolation on the `customers` table.
 *
 * Creates two tenants + owners via the admin client, inserts a customer
 * for each, then signs in as user A with the anon client and verifies:
 *   - SELECT returns A's customer, not B's.
 *   - A direct `eq('id', B.customerId)` returns no row.
 *   - UPDATE against B's customer affects zero rows (RLS USING denies).
 *
 * Skipped without DATABASE_URL + service-role credentials.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, tenants } from '@/lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
const canRun = hasDb && hasSupabase;

describe.skipIf(!canRun)('customers RLS isolation (integration)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('tenant A cannot see or mutate tenant B customers', async () => {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

    const admin = createSupabaseClient(supaUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `rls-a-${stamp}@heyhenry.test`;
    const emailB = `rls-b-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';

    let userIdA: string | null = null;
    let userIdB: string | null = null;
    let tenantIdA: string | null = null;
    let tenantIdB: string | null = null;

    try {
      // ---- Provision tenant A ----
      const createdA = await admin.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      userIdA = createdA.data.user?.id ?? null;
      expect(userIdA).toBeTruthy();

      const tenantInsertA = await admin
        .from('tenants')
        .insert({ name: `RLS A ${stamp}` })
        .select('id')
        .single();
      tenantIdA = tenantInsertA.data?.id ?? null;
      expect(tenantIdA).toBeTruthy();

      await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdA, user_id: userIdA, role: 'owner' });

      const custAInsert = await admin
        .from('customers')
        .insert({
          tenant_id: tenantIdA,
          type: 'residential',
          name: `A-Customer-${stamp}`,
        })
        .select('id')
        .single();
      const customerIdA = custAInsert.data?.id as string;
      expect(customerIdA).toBeTruthy();

      // ---- Provision tenant B ----
      const createdB = await admin.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      userIdB = createdB.data.user?.id ?? null;
      expect(userIdB).toBeTruthy();

      const tenantInsertB = await admin
        .from('tenants')
        .insert({ name: `RLS B ${stamp}` })
        .select('id')
        .single();
      tenantIdB = tenantInsertB.data?.id ?? null;
      expect(tenantIdB).toBeTruthy();

      await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdB, user_id: userIdB, role: 'owner' });

      const custBInsert = await admin
        .from('customers')
        .insert({
          tenant_id: tenantIdB,
          type: 'commercial',
          name: `B-Customer-${stamp}`,
        })
        .select('id')
        .single();
      const customerIdB = custBInsert.data?.id as string;
      expect(customerIdB).toBeTruthy();

      // ---- Sign in as user A with the anon client (RLS active) ----
      const anonA = createSupabaseClient(supaUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signInRes = await anonA.auth.signInWithPassword({ email: emailA, password });
      expect(signInRes.error).toBeNull();

      // Generic SELECT: only A's customer is visible.
      const listRes = await anonA.from('customers').select('id, name, tenant_id');
      expect(listRes.error).toBeNull();
      const rows = listRes.data ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(customerIdA);
      expect(rows[0].tenant_id).toBe(tenantIdA);

      // Targeted lookup of B's customer returns no row (not an error).
      const targeted = await anonA
        .from('customers')
        .select('id')
        .eq('id', customerIdB)
        .maybeSingle();
      expect(targeted.data).toBeNull();

      // UPDATE against B's customer touches zero rows (RLS USING denies).
      const updateRes = await anonA
        .from('customers')
        .update({ notes: 'cross-tenant tamper' })
        .eq('id', customerIdB)
        .select('id');
      expect(updateRes.error).toBeNull();
      expect(updateRes.data ?? []).toHaveLength(0);

      // Sanity: the service-role view still sees both rows untouched.
      const allView = await admin
        .from('customers')
        .select('id, notes')
        .in('id', [customerIdA, customerIdB]);
      expect(allView.data).toHaveLength(2);
      const b = allView.data?.find((r) => r.id === customerIdB);
      expect(b?.notes).toBeNull();
    } finally {
      const db = getDb();
      if (tenantIdA) await db.delete(tenants).where(eq(tenants.id, tenantIdA));
      if (tenantIdB) await db.delete(tenants).where(eq(tenants.id, tenantIdB));
      if (userIdA) await admin.auth.admin.deleteUser(userIdA).catch(() => {});
      if (userIdB) await admin.auth.admin.deleteUser(userIdB).catch(() => {});
    }
  }, 45_000);
});
