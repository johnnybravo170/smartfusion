/**
 * "Will's Full Day" — end-to-end acceptance test.
 *
 * Proves the complete quote-to-payment lifecycle in one self-contained test:
 *   1. Sign up a fresh tenant
 *   2. Seed service catalog entries
 *   3. Create a customer
 *   4. Create a quote with manual surface entries
 *   5. Verify pricing calculates correctly
 *   6. Save as draft, then send, then accept
 *   7. Convert to job (status = booked)
 *   8. Progress job: booked -> in_progress -> complete
 *   9. Generate invoice from completed job
 *  10. Verify invoice amounts (subtotal + GST + total)
 *  11. Navigate to /invoices list
 *  12. Navigate to /inbox -> verify worklog entries exist
 *  13. Navigate to /dashboard -> verify stat counts
 *  14. Cleanup
 *
 * Self-contained: no dependency on existing seed data.
 * Cleanup: removes tenant + user in afterAll.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial("Will's full day: quote -> job -> invoice lifecycle", () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-will-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Will's PW Co ${stamp}`;
    const customerName = `Test Homeowner ${stamp}`;

    let createdUserId: string | null = null;
    let createdTenantId: string | null = null;

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

    test('complete business lifecycle', async ({ page }) => {
      // Generous timeout for the full lifecycle.
      test.setTimeout(120_000);

      // ----------------------------------------------------------------
      // 1. Sign up fresh tenant
      // ----------------------------------------------------------------
      await page.goto('/signup');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

      // Capture IDs via admin client.
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

      // ----------------------------------------------------------------
      // 2. Seed service catalog entries via admin
      // ----------------------------------------------------------------
      await admin.from('service_catalog').insert([
        {
          tenant_id: createdTenantId,
          surface_type: 'driveway',
          label: 'Driveway',
          price_per_sqft_cents: 15,
          min_charge_cents: 5000,
          active: true,
        },
        {
          tenant_id: createdTenantId,
          surface_type: 'siding',
          label: 'House Siding',
          price_per_sqft_cents: 25,
          min_charge_cents: 7500,
          active: true,
        },
      ]);

      // ----------------------------------------------------------------
      // 3. Create customer "Test Homeowner"
      // ----------------------------------------------------------------
      await page.goto('/customers');
      await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
      await page.getByRole('link', { name: /add.*(customer|your first)/i }).click();
      await page.waitForURL(/\/customers\/new$/);
      await page.getByLabel('Name').fill(customerName);
      await page.getByLabel('Email').fill('homeowner@example.com');
      await page.getByRole('button', { name: /create customer/i }).click();
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();

      // ----------------------------------------------------------------
      // 4. Create new quote
      // ----------------------------------------------------------------
      await page.goto('/quotes/new');

      // Pick customer.
      await page.getByText('Pick a customer').click();
      await page.getByRole('option', { name: customerName }).click();

      // Switch to manual entry mode.
      await page.getByRole('button', { name: /manual entry/i }).click();

      // Add driveway: 500 sqft -> 500 * $0.15 = $75.00
      await page.getByText('Driveway').first().click();
      await page.getByRole('option', { name: 'Driveway' }).click();
      await page.getByPlaceholder('0.0').fill('500');
      await page.getByRole('button', { name: /^add$/i }).click();

      // ----------------------------------------------------------------
      // 5. Verify pricing
      // ----------------------------------------------------------------
      await expect(page.getByText('500.0')).toBeVisible();
      await expect(page.getByText('$75.00')).toBeVisible();

      // Add siding: 1200 sqft -> 1200 * $0.25 = $300.00
      await page.getByText('Driveway').first().click();
      await page.getByRole('option', { name: 'House Siding' }).click();
      await page.getByPlaceholder('0.0').fill('1200');
      await page.getByRole('button', { name: /^add$/i }).click();

      await expect(page.getByText('1200.0')).toBeVisible();
      await expect(page.getByText('$300.00')).toBeVisible();

      // ----------------------------------------------------------------
      // 6. Save as draft
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: /save as draft/i }).click();
      await page.waitForURL(/\/quotes\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText('Draft');

      // Subtotal: $75 + $300 = $375; GST 5% = $18.75; Total = $393.75
      await expect(page.getByText('$393.75')).toBeVisible();

      // Send the quote.
      await page.getByRole('button', { name: /^send$/i }).click();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText('Sent', {
        timeout: 10_000,
      });

      // ----------------------------------------------------------------
      // 7. Mark accepted
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: /mark accepted/i }).click();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText(
        'Accepted',
        {
          timeout: 10_000,
        },
      );

      // ----------------------------------------------------------------
      // 8. Convert to job -> status = booked
      // ----------------------------------------------------------------
      await page.getByRole('button', { name: /convert to job/i }).click();
      await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText('Booked');

      const jobUrl = page.url();

      // ----------------------------------------------------------------
      // 9. Progress job: booked -> in_progress -> complete
      // ----------------------------------------------------------------
      await page.getByLabel('Change job status').click();
      await page.getByRole('option', { name: 'In progress' }).click();
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText(
        /in progress/i,
        { timeout: 10_000 },
      );

      await page.getByLabel('Change job status').click();
      await page.getByRole('option', { name: 'Complete' }).click();
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText(/complete/i, {
        timeout: 10_000,
      });

      // ----------------------------------------------------------------
      // 10. Generate invoice from completed job
      // ----------------------------------------------------------------
      const generateBtn = page.getByRole('button', { name: /generate invoice/i });
      await expect(generateBtn).toBeVisible({ timeout: 10_000 });
      await generateBtn.click();
      await page.waitForURL(/\/invoices\/[0-9a-f-]{36}$/, { timeout: 20_000 });

      // Verify amounts: $375.00 subtotal + $18.75 GST = $393.75 total
      await expect(page.getByText('$375.00', { exact: true })).toBeVisible();
      await expect(page.getByText('$18.75', { exact: true })).toBeVisible();
      await expect(page.getByText('$393.75', { exact: true })).toBeVisible();
      await expect(page.locator('[data-slot="invoice-status-badge"]').first()).toHaveText(/draft/i);

      // ----------------------------------------------------------------
      // 11. Navigate to /invoices list -> see the invoice
      // ----------------------------------------------------------------
      await page.goto('/invoices');
      await expect(page.getByRole('heading', { name: /invoices/i })).toBeVisible();
      await expect(page.getByText(customerName)).toBeVisible({ timeout: 10_000 });

      // ----------------------------------------------------------------
      // 12. Navigate to /inbox -> verify worklog entries exist
      // ----------------------------------------------------------------
      await page.goto('/inbox?tab=worklog');
      await expect(page.getByRole('heading', { name: /inbox/i })).toBeVisible();
      // We should see system entries for: quote sent, quote accepted,
      // job status changes (in_progress, complete), invoice created.
      // Just verify at least some entries are present.
      await expect(page.getByText(/quote/i).first()).toBeVisible({ timeout: 10_000 });

      // ----------------------------------------------------------------
      // 13. Navigate to /dashboard -> verify stat counts
      // ----------------------------------------------------------------
      await page.goto('/dashboard');
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      // "Unpaid invoices" should show at least 1.
      await expect(page.getByText('Unpaid invoices')).toBeVisible();
      const unpaidCard = page.locator('div').filter({ hasText: 'Unpaid invoices' });
      await expect(unpaidCard.getByText('1')).toBeVisible({ timeout: 10_000 });

      // Silence unused-var warnings.
      void jobUrl;
    });
  });
