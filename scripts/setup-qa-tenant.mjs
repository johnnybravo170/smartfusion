/**
 * Configures "Overflow Test Co" as the official QA / demo tenant.
 *
 * Idempotent — safe to re-run any time (e.g. to rotate the password or
 * re-activate a member).
 *
 * Usage:
 *   set -a && source .env.local && set +a
 *   node scripts/setup-qa-tenant.mjs
 *
 * What it does:
 *   1. tenants.is_demo = true — suppresses ALL outbound email + SMS for the
 *      tenant (logged as `suppressed_demo`, never sent) and excludes it from
 *      platform metrics. See src/lib/tenants/demo.ts.
 *   2. Resets the owner password to the shared QA password.
 *   3. Ensures a worker + bookkeeper member exist so /w and /bk layouts are
 *      testable, each with the shared QA password.
 *
 * It does NOT seed customers/projects — run scripts/seed-test-data.ts for
 * that (Overflow Test Co is a pressure_washing tenant, which that script
 * targets). See docs/qa-tenant.md.
 */
import { createClient } from '@supabase/supabase-js';

const TENANT_ID = '7098bd96-9cdd-47af-a412-3679af4cb536';
const OWNER_EMAIL = 'overflowtest@example.com';
const WORKER_EMAIL = 'overflowtest+worker@example.com';
const BOOKKEEPER_EMAIL = 'overflowtest+bookkeeper@example.com';
// Shared QA password. Not a secret — the tenant is demo-flagged and inert
// (no real email/SMS, excluded from metrics). Stored in the ops vault too.
const PASSWORD = 'QaTenant-2026!';

const { NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!NEXT_PUBLIC_SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.');
  process.exit(1);
}

const supabase = createClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

/** Find an auth user by email (single page — the user table is small). */
async function findUser(email) {
  const { data, error } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw error;
  return data.users.find((u) => u.email === email) ?? null;
}

/** Create the user if missing, otherwise reset its password. Returns the id. */
async function ensureUser(email) {
  const existing = await findUser(email);
  if (existing) {
    const { error } = await supabase.auth.admin.updateUserById(existing.id, {
      password: PASSWORD,
      email_confirm: true,
    });
    if (error) throw error;
    console.log(`  reset password: ${email}`);
    return existing.id;
  }
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (error || !data?.user) throw error ?? new Error(`createUser failed for ${email}`);
  console.log(`  created user: ${email}`);
  return data.user.id;
}

/** Ensure a tenant_members row with the given role, active for the user. */
async function ensureMember(userId, role, firstName, lastName) {
  const { data: existing } = await supabase
    .from('tenant_members')
    .select('id')
    .eq('tenant_id', TENANT_ID)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from('tenant_members')
      .update({ role, is_active_for_user: true, first_name: firstName, last_name: lastName })
      .eq('id', existing.id);
    if (error) throw error;
    console.log(`  member updated: ${role}`);
  } else {
    const { error } = await supabase.from('tenant_members').insert({
      tenant_id: TENANT_ID,
      user_id: userId,
      role,
      is_active_for_user: true,
      first_name: firstName,
      last_name: lastName,
    });
    if (error) throw error;
    console.log(`  member created: ${role}`);
  }
}

async function main() {
  // 1. Flag the tenant.
  const { error: flagErr } = await supabase
    .from('tenants')
    .update({ is_demo: true })
    .eq('id', TENANT_ID);
  if (flagErr) throw flagErr;
  console.log('tenants.is_demo = true');

  // 2 + 3. Owner, worker, bookkeeper.
  const ownerId = await ensureUser(OWNER_EMAIL);
  await ensureMember(ownerId, 'owner', 'QA', 'Owner');

  const workerId = await ensureUser(WORKER_EMAIL);
  await ensureMember(workerId, 'worker', 'QA', 'Worker');

  const bookkeeperId = await ensureUser(BOOKKEEPER_EMAIL);
  await ensureMember(bookkeeperId, 'bookkeeper', 'QA', 'Bookkeeper');

  console.log('\nQA tenant ready — Overflow Test Co (' + TENANT_ID + ')');
  console.log('  owner       ' + OWNER_EMAIL + '  /  ' + PASSWORD + '  → /dashboard');
  console.log('  worker      ' + WORKER_EMAIL + '  /  ' + PASSWORD + '  → /w');
  console.log('  bookkeeper  ' + BOOKKEEPER_EMAIL + '  /  ' + PASSWORD + '  → /bk');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
