/**
 * Seeded demo fixture for E2E specs.
 *
 * Creates a fully-set-up tenant via the admin client so specs don't
 * have to clear the email/phone verification gate by clicking through
 * the signup UI. The tenant ships with:
 *   - one owner user (email-confirmed + phone-verified)
 *   - one residential customer
 *   - one renovation project with budget categories + cost lines
 *   - the estimate marked approved
 *
 * Specs call `seedDemo()` in beforeAll, get back ids + creds, then
 * sign in as the owner and exercise the UI. afterAll calls
 * `tearDownDemo()` which hard-deletes the tenant (cascades members,
 * projects, customers, etc.) and the auth user.
 *
 * Specs that need additional state (an applied CO, a draw, etc.)
 * should layer it on top via the admin client themselves so each
 * spec stays narrow about the scenario it's verifying.
 */

import { createClient as createSupabaseClient, type SupabaseClient } from '@supabase/supabase-js';

export type SeededDemo = {
  admin: SupabaseClient;
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  customerId: string;
  projectId: string;
  /** Two budget categories created on the project, indexed by name. */
  budgetCategoryIdsByName: Record<string, string>;
  /** Cost line ids in insert order so specs can reference them. */
  costLineIds: string[];
};

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      'seedDemo requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in env.',
    );
  }
  return createSupabaseClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function seedDemo(opts: { label?: string } = {}): Promise<SeededDemo> {
  const admin = adminClient();
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-${opts.label ?? 'demo'}-${stamp}@heyhenry.test`;
  const password = 'Correct-Horse-9';

  // Auth user — email_confirm=true so the verification gate passes.
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    throw new Error(`seedDemo: createUser failed: ${createErr?.message ?? 'unknown'}`);
  }
  const userId = created.user.id;

  const { data: tenant, error: tenantErr } = await admin
    .from('tenants')
    .insert({ name: `E2E Demo ${stamp}`, vertical: 'renovation' })
    .select('id')
    .single();
  if (tenantErr || !tenant) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`seedDemo: insert tenant failed: ${tenantErr?.message}`);
  }
  const tenantId = tenant.id as string;

  const { error: memberErr } = await admin.from('tenant_members').insert({
    tenant_id: tenantId,
    user_id: userId,
    role: 'owner',
    phone: '+15551234567',
    phone_verified_at: new Date().toISOString(),
  });
  if (memberErr) {
    await admin.from('tenants').delete().eq('id', tenantId);
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    throw new Error(`seedDemo: insert tenant_member failed: ${memberErr.message}`);
  }

  // Customer + project.
  const { data: customer, error: customerErr } = await admin
    .from('customers')
    .insert({
      tenant_id: tenantId,
      name: 'Jane Homeowner',
      email: `jane-${stamp}@example.test`,
      type: 'residential',
    })
    .select('id')
    .single();
  if (customerErr || !customer) {
    await tearDownDemo({ admin, userId, tenantId });
    throw new Error(`seedDemo: insert customer failed: ${customerErr?.message}`);
  }
  const customerId = customer.id as string;

  const { data: project, error: projectErr } = await admin
    .from('projects')
    .insert({
      tenant_id: tenantId,
      customer_id: customerId,
      name: 'Kitchen reno',
      lifecycle_stage: 'estimating',
      management_fee_rate: 0.18,
      estimate_status: 'approved',
      estimate_approved_at: new Date().toISOString(),
      estimate_approved_by_name: 'Jane Homeowner',
    })
    .select('id')
    .single();
  if (projectErr || !project) {
    await tearDownDemo({ admin, userId, tenantId });
    throw new Error(`seedDemo: insert project failed: ${projectErr?.message}`);
  }
  const projectId = project.id as string;

  // Two budget categories with realistic envelopes.
  const { data: cats, error: catErr } = await admin
    .from('project_budget_categories')
    .insert([
      {
        tenant_id: tenantId,
        project_id: projectId,
        name: 'Cabinets',
        section: 'interior',
        estimate_cents: 1500000,
        display_order: 1,
        is_visible_in_report: true,
      },
      {
        tenant_id: tenantId,
        project_id: projectId,
        name: 'Plumbing',
        section: 'interior',
        estimate_cents: 800000,
        display_order: 2,
        is_visible_in_report: true,
      },
    ])
    .select('id, name');
  if (catErr || !cats) {
    await tearDownDemo({ admin, userId, tenantId });
    throw new Error(`seedDemo: insert categories failed: ${catErr?.message}`);
  }
  const budgetCategoryIdsByName: Record<string, string> = {};
  for (const c of cats as { id: string; name: string }[]) {
    budgetCategoryIdsByName[c.name] = c.id;
  }

  // A few cost lines, one per category, summing to less than the
  // envelope so the by-category breakdown shows non-zero margin.
  const { data: lines, error: lineErr } = await admin
    .from('project_cost_lines')
    .insert([
      {
        tenant_id: tenantId,
        project_id: projectId,
        budget_category_id: budgetCategoryIdsByName.Cabinets,
        category: 'material',
        label: 'Shaker uppers + lowers',
        qty: 1,
        unit: 'set',
        unit_cost_cents: 900000,
        unit_price_cents: 1300000,
        markup_pct: 44,
        line_cost_cents: 900000,
        line_price_cents: 1300000,
        sort_order: 1,
      },
      {
        tenant_id: tenantId,
        project_id: projectId,
        budget_category_id: budgetCategoryIdsByName.Plumbing,
        category: 'sub',
        label: 'Rough-in + fixtures',
        qty: 1,
        unit: 'job',
        unit_cost_cents: 500000,
        unit_price_cents: 700000,
        markup_pct: 40,
        line_cost_cents: 500000,
        line_price_cents: 700000,
        sort_order: 1,
      },
    ])
    .select('id');
  if (lineErr || !lines) {
    await tearDownDemo({ admin, userId, tenantId });
    throw new Error(`seedDemo: insert cost lines failed: ${lineErr?.message}`);
  }
  const costLineIds = (lines as { id: string }[]).map((l) => l.id);

  return {
    admin,
    email,
    password,
    userId,
    tenantId,
    customerId,
    projectId,
    budgetCategoryIdsByName,
    costLineIds,
  };
}

export async function tearDownDemo(seed: {
  admin: SupabaseClient;
  userId: string;
  tenantId: string;
}): Promise<void> {
  // Tenant delete cascades through members / projects / cost_lines /
  // budget_categories / customers (FK ON DELETE CASCADE).
  await seed.admin.from('tenants').delete().eq('id', seed.tenantId);
  await seed.admin.auth.admin.deleteUser(seed.userId).catch(() => {});
}

/**
 * Sign the seeded owner in via the /login page and wait for the
 * dashboard. Use after seedDemo() so the page lands authenticated and
 * past the verification gate.
 */
export async function signInAsOwner(
  page: import('@playwright/test').Page,
  seed: Pick<SeededDemo, 'email' | 'password'>,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });
}
