/**
 * Cross-tenant RLS isolation — comprehensive coverage.
 *
 * Provisions two tenants (A and B) via the admin client, seeds rows in
 * every high-risk table for each, then signs in as user A with the anon
 * client and runs a fixed set of assertions per table:
 *
 *   1. SELECT * FROM <table>                     → never sees B's row
 *   2. SELECT * FROM <table> WHERE id = <B.id>   → returns null
 *   3. UPDATE <table> SET ... WHERE id = <B.id>  → affects zero rows
 *   4. DELETE FROM <table> WHERE id = <B.id>     → affects zero rows
 *   5. INSERT INTO <table> ... tenant_id = B     → rejected by WITH CHECK
 *
 * If any of these returns a row or affects a row count, the test fails —
 * a missing or broken RLS policy is leaking cross-tenant data.
 *
 * **To add a table**: append an entry to `RLS_TABLE_CASES`. Provide:
 *   - `table`: the public table name
 *   - `seedA(ctx)` and `seedB(ctx)`: build an insert payload using the
 *     ctx-supplied tenant id + helpers. Return the row's primary-key value.
 *   - `pk`: name of the primary-key column (default 'id')
 *   - `tenantIdColumn`: column that holds the tenant scope (default 'tenant_id')
 *   - `skipInsertReject`: skip the WITH-CHECK insert test if the table doesn't
 *     have a tenant_id column the anon client can set directly.
 *
 * Skipped without DATABASE_URL + Supabase service-role credentials.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb, tenants } from '@/lib/db/client';

const hasDb = Boolean(process.env.DATABASE_URL);
const hasSupabase = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_ROLE_KEY &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
);
const canRun = hasDb && hasSupabase;

type ProvisionedTenant = {
  userId: string;
  tenantId: string;
  email: string;
  // Optional helper rows seeded via the admin client so child tables can
  // FK against them (customer_id, project_id, etc).
  customerId: string;
  projectId: string;
  quoteId: string;
  jobId: string;
  invoiceId: string;
  arContactId: string;
};

type SeedCtx = {
  admin: SupabaseClient;
  tenant: ProvisionedTenant;
  /** Stamp shared across both tenants for naming uniqueness. */
  stamp: string;
};

type RlsCase = {
  /** Public table name. */
  table: string;
  /** Seed B's row via admin. Returns primary-key value. */
  seed: (ctx: SeedCtx) => Promise<string>;
  /** Patch payload used by the UPDATE attempt. */
  updatePayload: Record<string, unknown>;
  /** Build an INSERT payload that would target B's tenant_id (rejected by WITH CHECK). */
  insertAcrossTenants?: (ctx: SeedCtx) => Record<string, unknown>;
  /** Primary-key column name. Defaults to 'id'. */
  pk?: string;
  /** Skip the WITH-CHECK insert test (use when the table doesn't directly accept tenant_id). */
  skipInsertReject?: boolean;
};

const RLS_TABLE_CASES: RlsCase[] = [
  {
    table: 'customers',
    seed: async ({ admin, tenant, stamp }) => {
      const r = await admin
        .from('customers')
        .insert({
          tenant_id: tenant.tenantId,
          name: `cust-${stamp}`,
          type: 'residential',
          kind: 'customer',
        })
        .select('id')
        .single();
      return r.data?.id as string;
    },
    updatePayload: { notes: 'cross-tenant tamper' },
    insertAcrossTenants: ({ tenant, stamp }) => ({
      tenant_id: tenant.tenantId,
      name: `inject-${stamp}`,
      type: 'residential',
      kind: 'customer',
    }),
  },
  {
    table: 'projects',
    seed: async ({ tenant }) => tenant.projectId,
    updatePayload: { description: 'cross-tenant tamper' },
    insertAcrossTenants: ({ tenant, stamp }) => ({
      tenant_id: tenant.tenantId,
      name: `proj-inject-${stamp}`,
      customer_id: tenant.customerId,
    }),
  },
  {
    table: 'quotes',
    seed: async ({ tenant }) => tenant.quoteId,
    updatePayload: { notes: 'cross-tenant tamper' },
    insertAcrossTenants: ({ tenant }) => ({
      tenant_id: tenant.tenantId,
      customer_id: tenant.customerId,
      status: 'draft',
      subtotal_cents: 0,
      tax_cents: 0,
      total_cents: 0,
    }),
  },
  {
    table: 'jobs',
    seed: async ({ tenant }) => tenant.jobId,
    updatePayload: { notes: 'cross-tenant tamper' },
    insertAcrossTenants: ({ tenant }) => ({
      tenant_id: tenant.tenantId,
      customer_id: tenant.customerId,
      status: 'booked',
    }),
  },
  {
    table: 'invoices',
    seed: async ({ tenant }) => tenant.invoiceId,
    updatePayload: { customer_note: 'cross-tenant tamper' },
    skipInsertReject: true,
  },
  {
    table: 'worklog_entries',
    seed: async ({ admin, tenant, stamp }) => {
      const r = await admin
        .from('worklog_entries')
        .insert({
          tenant_id: tenant.tenantId,
          entry_type: 'note',
          title: `worklog-${stamp}`,
          body: 'seed',
        })
        .select('id')
        .single();
      return r.data?.id as string;
    },
    updatePayload: { body: 'cross-tenant tamper' },
    insertAcrossTenants: ({ tenant, stamp }) => ({
      tenant_id: tenant.tenantId,
      entry_type: 'note',
      title: `worklog-inject-${stamp}`,
      body: 'inject',
    }),
  },
  {
    table: 'ar_contacts',
    seed: async ({ tenant }) => tenant.arContactId,
    updatePayload: { first_name: 'tampered' },
    insertAcrossTenants: ({ tenant, stamp }) => ({
      tenant_id: tenant.tenantId,
      email: `inject-${stamp}@heyhenry.test`,
    }),
  },
  {
    table: 'email_send_log',
    seed: async ({ admin, tenant, stamp }) => {
      const r = await admin
        .from('email_send_log')
        .insert({
          tenant_id: tenant.tenantId,
          direction: 'outbound',
          to_address: `seed-${stamp}@heyhenry.test`,
          subject: 'seed',
          status: 'sent',
          casl_category: 'transactional',
        })
        .select('id')
        .single();
      return r.data?.id as string;
    },
    updatePayload: { subject: 'cross-tenant tamper' },
    skipInsertReject: true, // RLS uses service-role-only policy; anon cannot insert at all
  },
  {
    table: 'twilio_messages',
    seed: async ({ admin, tenant, stamp }) => {
      const r = await admin
        .from('twilio_messages')
        .insert({
          tenant_id: tenant.tenantId,
          direction: 'outbound',
          identity: 'operator',
          from_number: '+15555550100',
          to_number: '+15555550101',
          body: `seed-${stamp}`,
          status: 'sent',
          casl_category: 'transactional',
        })
        .select('id')
        .single();
      return r.data?.id as string;
    },
    updatePayload: { body: 'cross-tenant tamper' },
    skipInsertReject: true,
  },
  {
    table: 'consent_events',
    seed: async ({ admin, tenant, stamp }) => {
      const r = await admin
        .from('consent_events')
        .insert({
          tenant_id: tenant.tenantId,
          email: `consent-${stamp}@heyhenry.test`,
          consent_type: 'email_marketing',
          source: 'admin_import',
        })
        .select('id')
        .single();
      return r.data?.id as string;
    },
    updatePayload: { wording_shown: 'cross-tenant tamper' },
    skipInsertReject: true,
  },
];

async function provisionTenant(
  admin: SupabaseClient,
  tag: string,
  stamp: string,
): Promise<ProvisionedTenant> {
  const email = `rls-${tag}-${stamp}@heyhenry.test`;
  const password = 'Correct-Horse-9';

  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  const userId = created.data.user?.id;
  if (!userId) throw new Error(`createUser failed for ${tag}`);

  const tenantInsert = await admin
    .from('tenants')
    .insert({ name: `RLS ${tag} ${stamp}` })
    .select('id')
    .single();
  const tenantId = tenantInsert.data?.id as string;
  if (!tenantId) throw new Error(`tenant insert failed for ${tag}`);

  await admin
    .from('tenant_members')
    .insert({ tenant_id: tenantId, user_id: userId, role: 'owner', is_active_for_user: true });

  // Seed a customer + project + quote + job + invoice + ar_contact so the
  // child-table cases can FK against real rows. We do this once per tenant
  // up front so each table case can read these via tenant.<id>.
  const customer = await admin
    .from('customers')
    .insert({ tenant_id: tenantId, name: `cust-seed-${tag}-${stamp}`, type: 'residential' })
    .select('id')
    .single();
  const customerId = customer.data?.id as string;

  const project = await admin
    .from('projects')
    .insert({ tenant_id: tenantId, customer_id: customerId, name: `proj-seed-${tag}-${stamp}` })
    .select('id')
    .single();
  const projectId = project.data?.id as string;

  const quote = await admin
    .from('quotes')
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      status: 'draft',
      subtotal_cents: 0,
      tax_cents: 0,
      total_cents: 0,
    })
    .select('id')
    .single();
  const quoteId = quote.data?.id as string;

  const job = await admin
    .from('jobs')
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      quote_id: quoteId,
      status: 'booked',
    })
    .select('id')
    .single();
  const jobId = job.data?.id as string;

  const invoice = await admin
    .from('invoices')
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      job_id: jobId,
      status: 'draft',
      amount_cents: 0,
      tax_cents: 0,
    })
    .select('id')
    .single();
  const invoiceId = invoice.data?.id as string;

  const arContact = await admin
    .from('ar_contacts')
    .insert({ tenant_id: tenantId, email: `ar-${tag}-${stamp}@heyhenry.test` })
    .select('id')
    .single();
  const arContactId = arContact.data?.id as string;

  return {
    userId,
    tenantId,
    email,
    customerId,
    projectId,
    quoteId,
    jobId,
    invoiceId,
    arContactId,
  };
}

describe.skipIf(!canRun)('cross-tenant RLS isolation (integration)', () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const password = 'Correct-Horse-9';

  let admin: SupabaseClient;
  let tenantA: ProvisionedTenant;
  let tenantB: ProvisionedTenant;
  let anonA: SupabaseClient;
  // Per-table B-side row IDs, populated in beforeAll.
  const seededIds: Record<string, string> = {};

  beforeAll(async () => {
    const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY as string;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

    admin = createSupabaseClient(supaUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    tenantA = await provisionTenant(admin, 'a', stamp);
    tenantB = await provisionTenant(admin, 'b', stamp);

    anonA = createSupabaseClient(supaUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signIn = await anonA.auth.signInWithPassword({ email: tenantA.email, password });
    if (signIn.error) throw new Error(`anon-A sign-in failed: ${signIn.error.message}`);

    // Seed every case's B-side row so the test loop can target it.
    for (const c of RLS_TABLE_CASES) {
      const id = await c.seed({ admin, tenant: tenantB, stamp });
      if (!id) throw new Error(`seed failed for ${c.table} (B)`);
      seededIds[c.table] = id;
    }
  }, 90_000);

  afterAll(async () => {
    const db = getDb();
    if (tenantA?.tenantId) await db.delete(tenants).where(eq(tenants.id, tenantA.tenantId));
    if (tenantB?.tenantId) await db.delete(tenants).where(eq(tenants.id, tenantB.tenantId));
    if (tenantA?.userId) await admin.auth.admin.deleteUser(tenantA.userId).catch(() => {});
    if (tenantB?.userId) await admin.auth.admin.deleteUser(tenantB.userId).catch(() => {});
    await closeDb();
  });

  describe('active-membership scoping (multi-tenant user)', () => {
    let multiUser: { userId: string; email: string };
    let anonMulti: SupabaseClient;
    const multiPassword = 'Correct-Horse-9-multi';

    beforeAll(async () => {
      // A user who belongs to BOTH tenant A and tenant B. Active starts on A.
      const email = `rls-multi-${stamp}@heyhenry.test`;
      const created = await admin.auth.admin.createUser({
        email,
        password: multiPassword,
        email_confirm: true,
      });
      const userId = created.data.user?.id;
      if (!userId) throw new Error('multi-user createUser failed');
      multiUser = { userId, email };

      await admin.from('tenant_members').insert({
        tenant_id: tenantA.tenantId,
        user_id: userId,
        role: 'member',
        is_active_for_user: true,
      });
      await admin.from('tenant_members').insert({
        tenant_id: tenantB.tenantId,
        user_id: userId,
        role: 'member',
        is_active_for_user: false,
      });

      const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;
      anonMulti = createSupabaseClient(supaUrl, anonKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const signIn = await anonMulti.auth.signInWithPassword({
        email,
        password: multiPassword,
      });
      if (signIn.error) throw new Error(`multi-user sign-in failed: ${signIn.error.message}`);
    }, 30_000);

    afterAll(async () => {
      if (multiUser?.userId) {
        await admin.auth.admin.deleteUser(multiUser.userId).catch(() => {});
      }
    });

    async function customerIdsVisible(client: SupabaseClient): Promise<string[]> {
      const r = await client.from('customers').select('id, tenant_id');
      if (r.error) throw new Error(`select failed: ${r.error.message}`);
      return (r.data ?? []).map((row) => (row as { id: string }).id);
    }

    it('sees only active tenant before/after switch', async () => {
      // Active = A. Should see A's seeded customer, not B's.
      let visible = await customerIdsVisible(anonMulti);
      expect(visible, 'multi-user (active=A) should see A.customer').toContain(tenantA.customerId);
      expect(visible, 'multi-user (active=A) should NOT see B.customer').not.toContain(
        tenantB.customerId,
      );

      // Switch to B via the SECURITY DEFINER RPC.
      const switchToB = await anonMulti.rpc('set_active_tenant_member', {
        target_tenant_id: tenantB.tenantId,
      });
      expect(switchToB.error, 'switch to B should succeed').toBeNull();

      visible = await customerIdsVisible(anonMulti);
      expect(visible, 'multi-user (active=B) should see B.customer').toContain(tenantB.customerId);
      expect(visible, 'multi-user (active=B) should NOT see A.customer').not.toContain(
        tenantA.customerId,
      );

      // Switch back to A.
      const switchToA = await anonMulti.rpc('set_active_tenant_member', {
        target_tenant_id: tenantA.tenantId,
      });
      expect(switchToA.error, 'switch back to A should succeed').toBeNull();

      visible = await customerIdsVisible(anonMulti);
      expect(visible, 'multi-user (active=A again) should see A.customer').toContain(
        tenantA.customerId,
      );
      expect(visible, 'multi-user (active=A again) should NOT see B.customer').not.toContain(
        tenantB.customerId,
      );
    }, 30_000);

    it('cannot switch into a tenant the user does not belong to', async () => {
      // Provision a stranger tenant the multi-user has no membership in.
      const stranger = await provisionTenant(admin, 'stranger', stamp);
      try {
        const result = await anonMulti.rpc('set_active_tenant_member', {
          target_tenant_id: stranger.tenantId,
        });
        expect(result.error, 'RPC should reject switching to a non-member tenant').not.toBeNull();
      } finally {
        const db = getDb();
        await db.delete(tenants).where(eq(tenants.id, stranger.tenantId));
        await admin.auth.admin.deleteUser(stranger.userId).catch(() => {});
      }
    }, 30_000);
  });

  it.each(RLS_TABLE_CASES.map((c) => [c.table, c]))(
    '%s: tenant A cannot read or mutate tenant B rows',
    async (_label, c) => {
      const pk = c.pk ?? 'id';
      const bRowId = seededIds[c.table];
      expect(bRowId).toBeTruthy();

      // 1. Generic SELECT — must not include B's row id.
      const list = await anonA.from(c.table).select(pk);
      // Some tables may legitimately error for the anon role (e.g. service-only
      // RLS policies). Treat that as still-secure: anon couldn't read B's row.
      if (list.error) {
        // Pass — the table doesn't even let anon SELECT.
      } else {
        const ids = (list.data ?? []).map((r) => (r as unknown as Record<string, unknown>)[pk]);
        expect(ids, `${c.table}: anon-A should not see B's row in list`).not.toContain(bRowId);
      }

      // 2. Targeted lookup of B's row should return null.
      const targeted = await anonA.from(c.table).select(pk).eq(pk, bRowId).maybeSingle();
      expect(targeted.data, `${c.table}: targeted lookup of B's row leaked`).toBeNull();

      // 3. UPDATE B's row → zero rows affected.
      const update = await anonA.from(c.table).update(c.updatePayload).eq(pk, bRowId).select(pk);
      // Either an explicit error or zero rows is acceptable.
      const updatedRows = update.data ?? [];
      expect(
        updatedRows.length,
        `${c.table}: UPDATE on B's row affected ${updatedRows.length} rows`,
      ).toBe(0);

      // 4. DELETE B's row → zero rows affected.
      const del = await anonA.from(c.table).delete().eq(pk, bRowId).select(pk);
      const deletedRows = del.data ?? [];
      expect(
        deletedRows.length,
        `${c.table}: DELETE on B's row affected ${deletedRows.length} rows`,
      ).toBe(0);

      // 5. INSERT with cross-tenant payload → rejected by WITH CHECK.
      if (!c.skipInsertReject && c.insertAcrossTenants) {
        const payload = c.insertAcrossTenants({ admin, tenant: tenantB, stamp });
        const insert = await anonA.from(c.table).insert(payload).select(pk);
        // Either an error or zero inserted rows is acceptable.
        const insertedRows = insert.data ?? [];
        expect(
          insertedRows.length,
          `${c.table}: cross-tenant INSERT created ${insertedRows.length} rows (RLS WITH CHECK should reject)`,
        ).toBe(0);
      }

      // 6. Sanity: service-role can still see B's row untouched.
      const sanity = await admin.from(c.table).select(pk).eq(pk, bRowId).maybeSingle();
      expect(sanity.data, `${c.table}: service-role lost sight of B's row`).not.toBeNull();
    },
    30_000,
  );
});
