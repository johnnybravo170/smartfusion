/**
 * Foundation smoke test — Phase 1A acceptance gate.
 *
 * One-shot end-to-end check that the foundation works against whatever
 * Supabase instance NEXT_PUBLIC_SUPABASE_URL points at (by default the
 * remote project; set the env to the local URL to run against `supabase
 * start`).
 *
 * What it does:
 *   1. Create tenant A + owner-user A via the admin client.
 *   2. Create tenant B + owner-user B via the admin client.
 *   3. Sign in as user A (via supabase-js) with the anon key.
 *   4. Assert `current_tenant_id()` returns tenant A's UUID for user A.
 *   5. Assert user A can SELECT tenant A's row (RLS allows).
 *   6. Assert user A sees exactly 1 row when selecting from tenants
 *      (RLS blocks tenant B's row — cross-tenant isolation).
 *   7. Clean up both tenants + both users.
 *
 * Exit 0 on success. Exit 1 and print a diagnostic on any failure (still
 * attempts cleanup).
 *
 * Run locally:
 *   source .env.local && pnpm smoke
 * or
 *   pnpm tsx scripts/smoke-foundation.ts
 */

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

// biome-ignore lint/suspicious/noExplicitAny: smoke test, schema typing unimportant
type SupabaseAdmin = SupabaseClient<any, any, any>;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function die(msg: string, err?: unknown): never {
  console.error(`[smoke] FAIL: ${msg}`);
  if (err) console.error(err);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`[smoke] ok  ${msg}`);
}

function info(msg: string): void {
  console.log(`[smoke] ... ${msg}`);
}

async function cleanup(
  admin: SupabaseAdmin,
  tenantIds: (string | null)[],
  userIds: (string | null)[],
): Promise<void> {
  for (const tid of tenantIds) {
    if (!tid) continue;
    try {
      await admin.from('tenants').delete().eq('id', tid);
    } catch {
      /* swallow */
    }
  }
  for (const uid of userIds) {
    if (!uid) continue;
    try {
      await admin.auth.admin.deleteUser(uid);
    } catch {
      /* swallow */
    }
  }
}

async function main(): Promise<void> {
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    die(
      'Missing env vars. Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY. Run `source .env.local` first.',
    );
  }

  const admin = createSupabaseClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emailA = `smoke-a-${stamp}@heyhenry.test`;
  const emailB = `smoke-b-${stamp}@heyhenry.test`;
  const password = 'Correct-Horse-9';
  const nameA = `Smoke A ${stamp}`;
  const nameB = `Smoke B ${stamp}`;

  let userIdA: string | null = null;
  let userIdB: string | null = null;
  let tenantIdA: string | null = null;
  let tenantIdB: string | null = null;

  try {
    // 1. Create tenant A + user A.
    info(`creating tenant A + user A (${emailA})`);
    {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: emailA,
        password,
        email_confirm: true,
      });
      if (error || !created.user) die('createUser A failed', error);
      userIdA = created.user.id;
    }
    {
      const { data: tenant, error } = await admin
        .from('tenants')
        .insert({ name: nameA })
        .select('id')
        .single();
      if (error || !tenant) die('insert tenant A failed', error);
      tenantIdA = tenant.id as string;
    }
    {
      const { error } = await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdA, user_id: userIdA, role: 'owner' });
      if (error) die('insert tenant_member A failed', error);
    }
    ok(`tenant A ${tenantIdA} / user A ${userIdA}`);

    // 2. Create tenant B + user B (the "invisible neighbour").
    info(`creating tenant B + user B (${emailB})`);
    {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: emailB,
        password,
        email_confirm: true,
      });
      if (error || !created.user) die('createUser B failed', error);
      userIdB = created.user.id;
    }
    {
      const { data: tenant, error } = await admin
        .from('tenants')
        .insert({ name: nameB })
        .select('id')
        .single();
      if (error || !tenant) die('insert tenant B failed', error);
      tenantIdB = tenant.id as string;
    }
    {
      const { error } = await admin
        .from('tenant_members')
        .insert({ tenant_id: tenantIdB, user_id: userIdB, role: 'owner' });
      if (error) die('insert tenant_member B failed', error);
    }
    ok(`tenant B ${tenantIdB} / user B ${userIdB}`);

    // 3. Sign in as user A with the anon key (carries RLS as `authenticated`).
    info('signing in as user A with anon key (RLS on)');
    const userClient = createSupabaseClient(SUPABASE_URL as string, ANON_KEY as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    {
      const { data, error } = await userClient.auth.signInWithPassword({
        email: emailA,
        password,
      });
      if (error || !data.session) die('signInWithPassword A failed', error);
    }
    ok('user A signed in');

    // 4. current_tenant_id() must return tenant A's UUID.
    info('calling current_tenant_id() as user A');
    {
      const { data, error } = await userClient.rpc('current_tenant_id');
      if (error) die('rpc current_tenant_id failed', error);
      if (data !== tenantIdA) {
        die(`current_tenant_id returned ${String(data)} but expected ${tenantIdA}`);
      }
    }
    ok(`current_tenant_id() == ${tenantIdA}`);

    // 5. User A can SELECT tenant A's row.
    info('selecting tenant A as user A');
    {
      const { data, error } = await userClient
        .from('tenants')
        .select('id, name')
        .eq('id', tenantIdA);
      if (error) die('select own tenant failed', error);
      if (!data || data.length !== 1) {
        die(`expected 1 row for own tenant, got ${data?.length ?? 0}`);
      }
      if (data[0].id !== tenantIdA) {
        die(`own tenant id mismatch: got ${data[0].id}, want ${tenantIdA}`);
      }
    }
    ok('user A sees own tenant row');

    // 6. RLS blocks cross-tenant read: selecting all tenants returns only A.
    info('selecting all tenants as user A (RLS must hide tenant B)');
    {
      const { data, error } = await userClient.from('tenants').select('id');
      if (error) die('select all tenants failed', error);
      if (!data) die('select all tenants returned no data');
      const ids = data.map((r) => r.id);
      if (!ids.includes(tenantIdA)) die('tenant A not visible to user A');
      if (ids.includes(tenantIdB)) {
        die(`RLS HOLE: tenant B (${tenantIdB}) is visible to user A. ids=${JSON.stringify(ids)}`);
      }
      if (ids.length !== 1) {
        die(`expected exactly 1 tenant row (own), got ${ids.length}: ${JSON.stringify(ids)}`);
      }
    }
    ok('RLS blocks cross-tenant read — tenant B invisible to user A');

    // 7. Direct eq(tenantIdB) returns zero (not an error, just empty).
    info('directly querying tenant B as user A (expect 0 rows)');
    {
      const { data, error } = await userClient.from('tenants').select('id').eq('id', tenantIdB);
      if (error) die('select tenant B failed', error);
      if (data?.length !== 0) {
        die(`expected 0 rows for cross-tenant eq(), got ${data?.length}`);
      }
    }
    ok('cross-tenant eq() returns 0 rows');

    // Sign out before cleanup.
    await userClient.auth.signOut().catch(() => undefined);

    console.log('\n[smoke] PASS — foundation is solid.\n');
  } catch (err) {
    console.error('[smoke] unexpected error:', err);
    await cleanup(admin, [tenantIdA, tenantIdB], [userIdA, userIdB]);
    process.exit(1);
  }

  // Cleanup on the happy path.
  info('cleaning up');
  await cleanup(admin, [tenantIdA, tenantIdB], [userIdA, userIdB]);
  ok('cleanup complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
