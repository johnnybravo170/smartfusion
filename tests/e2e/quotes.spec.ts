/**
 * End-to-end test for the Quotes (Track B) module.
 *
 * Signs up a fresh tenant, seeds a customer + catalog entries via admin
 * client, then walks through the full quote lifecycle:
 *   1. Sign up tenant
 *   2. Seed customer + catalog entries
 *   3. Visit /quotes → empty state
 *   4. Click "Create your first quote" → form
 *   5. Pick customer, add surface manually (no map dependency for CI)
 *   6. Verify price calculates correctly
 *   7. Save as draft → redirected to detail page
 *   8. Verify surfaces + total shown
 *   9. Click "Send" → status changes to sent
 *  10. Click "Mark accepted" → status accepted
 *  11. Click "Convert to job" → redirected to job detail
 *  12. Navigate to /quotes → list shows the quote
 *  13. Cleanup
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .skip('quotes lifecycle: create → send → accept → convert to job', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-quotes-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Quotes E2E Co ${stamp}`;
    const customerName = `Quote Customer ${stamp}`;

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

    test('full quote lifecycle with manual surface entry', async ({ page }) => {
      // --- 1. Sign up ---
      await page.goto('/signup');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

      // --- 2. Seed customer + catalog via admin ---
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

      // Seed customer.
      const { data: customer } = await admin
        .from('customers')
        .insert({
          tenant_id: createdTenantId,
          type: 'residential',
          name: customerName,
          email: 'test@example.com',
        })
        .select('id')
        .single();
      expect(customer?.id).toBeTruthy();

      // Seed catalog entries.
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

      // --- 3. Visit /quotes → empty state ---
      await page.goto('/quotes');
      await expect(page.getByRole('heading', { name: 'Quotes', exact: true })).toBeVisible();
      await expect(page.getByText(/no quotes yet/i)).toBeVisible();

      // --- 4. Click "Create your first quote" ---
      await page.getByRole('link', { name: /create your first quote/i }).click();
      await page.waitForURL(/\/quotes\/new$/);

      // --- 5. Pick customer ---
      await page.getByText('Pick a customer').click();
      await page.getByRole('option', { name: customerName }).click();

      // Switch to manual entry mode.
      await page.getByRole('button', { name: /manual entry/i }).click();

      // Add a driveway surface: 500 sqft.
      await page.getByText('Driveway').first().click();
      await page.getByRole('option', { name: 'Driveway' }).click();
      await page.getByPlaceholder('0.0').fill('500');
      await page.getByRole('button', { name: /^add$/i }).click();

      // --- 6. Verify surface in list ---
      await expect(page.getByText('500.0')).toBeVisible();
      // Price should be 500 * $0.15 = $75.00
      await expect(page.getByText('$75.00')).toBeVisible();

      // --- 7. Save as draft ---
      await page.getByRole('button', { name: /save as draft/i }).click();

      // --- 8. Redirected to detail page ---
      await page.waitForURL(/\/quotes\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText('Draft');
      // Verify total: $75 subtotal + $3.75 GST = $78.75
      await expect(page.getByText('$78.75')).toBeVisible();

      // --- 9. Send the quote ---
      await page.getByRole('button', { name: /^send$/i }).click();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText('Sent', {
        timeout: 10_000,
      });

      // --- 10. Accept the quote ---
      await page.getByRole('button', { name: /mark accepted/i }).click();
      await expect(page.locator('[data-slot="quote-status-badge"]').first()).toHaveText(
        'Accepted',
        {
          timeout: 10_000,
        },
      );

      // --- 11. Convert to job ---
      await page.getByRole('button', { name: /convert to job/i }).click();
      await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText('Booked');

      // --- 12. Verify quote appears in list ---
      await page.goto('/quotes');
      await expect(page.getByText(customerName)).toBeVisible({ timeout: 10_000 });
    });
  });
