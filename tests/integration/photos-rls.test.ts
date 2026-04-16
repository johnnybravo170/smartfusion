/**
 * Integration test: cross-tenant RLS isolation on `photos` + `storage.objects`.
 *
 * Creates two tenants via admin, inserts a customer + job + photo row for
 * each, and uploads a tiny blob to each tenant's storage prefix. Signs in
 * as user A with the anon client and verifies:
 *   - SELECT on `photos` returns only A's row.
 *   - Targeted lookup of B's photo row returns null (RLS, not 404).
 *   - `storage.objects` SELECT (via `.list()` on the bucket prefix) sees
 *     only A's folder.
 *   - Signing a URL for B's storage path returns no URL (RLS denies).
 *
 * Skipped without DATABASE_URL + service-role credentials.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const FIXTURE_BYTES = (() => {
  try {
    return readFileSync(resolve(__dirname, '../fixtures/test-photo.png'));
  } catch {
    return Buffer.from('fake image data');
  }
})();

describe.skipIf(!canRun)('photos RLS isolation (integration)', () => {
  afterAll(async () => {
    await closeDb();
  });

  it('tenant A cannot see or sign tenant B photos', async () => {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

    const admin = createSupabaseClient(supaUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const emailA = `photo-rls-a-${stamp}@smartfusion.test`;
    const emailB = `photo-rls-b-${stamp}@smartfusion.test`;
    const password = 'Correct-Horse-9';

    let userIdA: string | null = null;
    let userIdB: string | null = null;
    let tenantIdA: string | null = null;
    let tenantIdB: string | null = null;
    let storagePathA = '';
    let storagePathB = '';

    try {
      // ---- Provision tenant A ----
      const createdA = await admin.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      userIdA = createdA.data.user?.id ?? null;
      expect(userIdA).toBeTruthy();

      const tenantA = await admin
        .from('tenants')
        .insert({ name: `Photo A ${stamp}` })
        .select('id')
        .single();
      tenantIdA = tenantA.data?.id ?? null;
      expect(tenantIdA).toBeTruthy();

      await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdA, user_id: userIdA, role: 'owner' });

      const custA = await admin
        .from('customers')
        .insert({ tenant_id: tenantIdA, type: 'residential', name: `A-${stamp}` })
        .select('id')
        .single();
      const jobA = await admin
        .from('jobs')
        .insert({ tenant_id: tenantIdA, customer_id: custA.data?.id, status: 'booked' })
        .select('id')
        .single();
      const jobIdA = jobA.data?.id as string;

      const photoIdA = crypto.randomUUID();
      storagePathA = `${tenantIdA}/${jobIdA}/${photoIdA}.png`;
      const upA = await admin.storage.from('photos').upload(storagePathA, FIXTURE_BYTES, {
        contentType: 'image/png',
        upsert: false,
      });
      expect(upA.error).toBeNull();

      const photoInsA = await admin
        .from('photos')
        .insert({
          id: photoIdA,
          tenant_id: tenantIdA,
          job_id: jobIdA,
          storage_path: storagePathA,
          tag: 'before',
        })
        .select('id')
        .single();
      expect(photoInsA.data?.id).toBe(photoIdA);

      // ---- Provision tenant B ----
      const createdB = await admin.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      userIdB = createdB.data.user?.id ?? null;
      expect(userIdB).toBeTruthy();

      const tenantB = await admin
        .from('tenants')
        .insert({ name: `Photo B ${stamp}` })
        .select('id')
        .single();
      tenantIdB = tenantB.data?.id ?? null;
      expect(tenantIdB).toBeTruthy();

      await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdB, user_id: userIdB, role: 'owner' });

      const custB = await admin
        .from('customers')
        .insert({ tenant_id: tenantIdB, type: 'commercial', name: `B-${stamp}` })
        .select('id')
        .single();
      const jobB = await admin
        .from('jobs')
        .insert({ tenant_id: tenantIdB, customer_id: custB.data?.id, status: 'booked' })
        .select('id')
        .single();
      const jobIdB = jobB.data?.id as string;

      const photoIdB = crypto.randomUUID();
      storagePathB = `${tenantIdB}/${jobIdB}/${photoIdB}.png`;
      const upB = await admin.storage.from('photos').upload(storagePathB, FIXTURE_BYTES, {
        contentType: 'image/png',
        upsert: false,
      });
      expect(upB.error).toBeNull();

      await admin.from('photos').insert({
        id: photoIdB,
        tenant_id: tenantIdB,
        job_id: jobIdB,
        storage_path: storagePathB,
        tag: 'after',
      });

      // ---- Sign in as A via anon client ----
      const anonA = createSupabaseClient(supaUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await anonA.auth.signInWithPassword({ email: emailA, password });
      expect(signIn.error).toBeNull();

      // photos table: only A's row visible.
      const listRes = await anonA.from('photos').select('id, tenant_id, storage_path');
      expect(listRes.error).toBeNull();
      const rows = listRes.data ?? [];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(photoIdA);
      expect(rows[0].tenant_id).toBe(tenantIdA);

      // Targeted B lookup returns nothing.
      const targeted = await anonA.from('photos').select('id').eq('id', photoIdB).maybeSingle();
      expect(targeted.data).toBeNull();

      // storage.objects: listing B's prefix returns an empty set.
      const listB = await anonA.storage.from('photos').list(tenantIdB as string);
      // Supabase returns an empty array rather than an error when RLS filters
      // everything out.
      expect(listB.data ?? []).toHaveLength(0);

      // Listing A's own prefix succeeds and contains the job folder.
      const listA = await anonA.storage.from('photos').list(tenantIdA as string);
      expect(listA.error).toBeNull();
      expect((listA.data ?? []).length).toBeGreaterThan(0);

      // Signing a URL for B's path returns null/error under RLS.
      const signB = await anonA.storage.from('photos').createSignedUrl(storagePathB, 60);
      expect(signB.data?.signedUrl ?? null).toBeNull();

      // Sanity: admin still sees both rows.
      const allView = await admin.from('photos').select('id').in('id', [photoIdA, photoIdB]);
      expect(allView.data).toHaveLength(2);
    } finally {
      // Storage + tenant cascade cleanup.
      if (storagePathA) {
        await admin.storage
          .from('photos')
          .remove([storagePathA])
          .catch(() => {});
      }
      if (storagePathB) {
        await admin.storage
          .from('photos')
          .remove([storagePathB])
          .catch(() => {});
      }
      const db = getDb();
      if (tenantIdA) await db.delete(tenants).where(eq(tenants.id, tenantIdA));
      if (tenantIdB) await db.delete(tenants).where(eq(tenants.id, tenantIdB));
      if (userIdA) await admin.auth.admin.deleteUser(userIdA).catch(() => {});
      if (userIdB) await admin.auth.admin.deleteUser(userIdB).catch(() => {});
    }
  }, 45_000);
});
