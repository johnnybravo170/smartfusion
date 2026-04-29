/**
 * End-to-end test for the Invoices (Phase 1C) module.
 *
 * Signs up a fresh tenant, seeds a customer + quote + completed job via admin
 * client, then walks through:
 *   1. /settings -> sees "Connect Stripe" button (don't click)
 *   2. /jobs/[id] -> sees "Generate invoice" button -> clicks
 *   3. /invoices/[id] -> sees draft invoice with correct amounts
 *   4. /invoices -> sees the invoice in the list
 *   5. Cleanup
 *
 * We cannot complete Stripe onboarding or payment in a headless browser,
 * so this test focuses on the draft creation flow.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe.skip.serial('invoices: settings + generate from job + list', () => {
  test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `e2e-inv-${stamp}@heyhenry.test`;
  const password = 'Correct-Horse-9';
  const businessName = `Invoice E2E Co ${stamp}`;
  const customerName = `Invoice Customer ${stamp}`;

  let createdUserId: string | null = null;
  let createdTenantId: string | null = null;
  let createdJobId: string | null = null;

  test.afterAll(async () => {
    if (!canRun) return;
    const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (!createdUserId) {
      const { data } = await admin.auth.admin.listUsers();
      const match = data?.users.find((u) => u.email === email);
      if (match) createdUserId = match.id;
    }
    if (createdUserId && !createdTenantId) {
      const { data } = await admin
        .from('tenant_members')
        .select('tenant_id')
        .eq('user_id', createdUserId)
        .maybeSingle();
      if (data) createdTenantId = data.tenant_id as string;
    }

    if (createdTenantId) {
      await admin.from('tenants').delete().eq('id', createdTenantId);
    }
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
    }
  });

  test('full invoice lifecycle', async ({ page }) => {
    // --- 1. Sign up ---
    await page.goto('/signup');
    await page.getByLabel('Business name').fill(businessName);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

    // Capture ids via admin client.
    const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: users } = await admin.auth.admin.listUsers();
    const user = users?.users.find((u) => u.email === email);
    expect(user).toBeTruthy();
    if (!user) throw new Error('User not found after signup');
    createdUserId = user.id;

    const { data: mem } = await admin
      .from('tenant_members')
      .select('tenant_id')
      .eq('user_id', user.id)
      .maybeSingle();
    expect(mem).toBeTruthy();
    createdTenantId = mem?.tenant_id as string;

    // --- 2. Settings page shows Connect Stripe ---
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: /settings/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /connect stripe/i })).toBeVisible();

    // --- 3. Seed customer + quote + completed job ---
    const { data: customer } = await admin
      .from('customers')
      .insert({
        tenant_id: createdTenantId,
        type: 'residential',
        name: customerName,
      })
      .select('id')
      .single();
    expect(customer?.id).toBeTruthy();
    const customerId = customer?.id as string;

    const { data: quote } = await admin
      .from('quotes')
      .insert({
        tenant_id: createdTenantId,
        customer_id: customerId,
        status: 'accepted',
        total_cents: 25000, // $250.00
      })
      .select('id')
      .single();
    expect(quote?.id).toBeTruthy();
    const quoteId = quote?.id as string;

    const now = new Date().toISOString();
    const { data: job } = await admin
      .from('jobs')
      .insert({
        tenant_id: createdTenantId,
        customer_id: customerId,
        quote_id: quoteId,
        status: 'complete',
        completed_at: now,
      })
      .select('id')
      .single();
    expect(job?.id).toBeTruthy();
    createdJobId = job?.id ?? null;

    // --- 4. Visit job detail -> Generate Invoice ---
    await page.goto(`/jobs/${createdJobId}`);
    await expect(page.getByRole('heading', { name: customerName })).toBeVisible();

    const generateBtn = page.getByRole('button', { name: /generate invoice/i });
    await expect(generateBtn).toBeVisible({ timeout: 10_000 });
    await generateBtn.click();

    // Should navigate to /invoices/[id].
    await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 20_000 });

    // --- 5. Invoice detail page ---
    await expect(page.getByText('$250.00', { exact: true })).toBeVisible(); // subtotal
    await expect(page.getByText('$12.50', { exact: true })).toBeVisible(); // 5% GST
    await expect(page.getByText('$262.50', { exact: true })).toBeVisible(); // total
    await expect(page.locator('[data-slot="invoice-status-badge"]').first()).toHaveText(/draft/i);

    // --- 6. Invoices list page ---
    await page.goto('/invoices');
    await expect(page.getByRole('heading', { name: /invoices/i })).toBeVisible();
    await expect(page.getByText(customerName)).toBeVisible({ timeout: 10_000 });

    // Silence unused-var warnings.
    void createdJobId;
  });
});
