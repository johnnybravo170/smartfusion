/**
 * End-to-end test for the Customers (Track A) module.
 *
 * Signs up a fresh tenant, walks through the full CRUD lifecycle, and then
 * tears the tenant down via the admin client. Skipped when service-role
 * credentials aren't available (needed for cleanup).
 *
 * Steps (per PHASE_1_PLAN.md §8 Track A):
 *   1. Sign up a new tenant with a unique email.
 *   2. Visit /customers → empty state is visible.
 *   3. Create "Acme Supply" (commercial) → redirected to detail page.
 *   4. Back to list → row is visible.
 *   5. Search "acme" → still visible. Search "xyz" → filtered empty state.
 *   6. Filter by type=residential → filtered empty state. type=commercial → visible.
 *   7. Click customer → detail shows name + Commercial badge.
 *   8. Edit name to "Acme Supply Ltd" → save → detail reflects new name.
 *   9. Delete → confirm → redirected to empty /customers.
 *  10. Cleanup (afterAll): drop the auth user + tenant via admin client.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('customers CRUD flow', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-customers-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Customers E2E Co ${stamp}`;

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

    test('full CRUD lifecycle for a commercial customer', async ({ page }) => {
      // --- 1. Sign up ---
      await page.goto('/signup');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

      // Capture ids for cleanup as early as possible.
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const { data: users } = await admin.auth.admin.listUsers();
      const user = users?.users.find((u) => u.email === email);
      if (user) {
        createdUserId = user.id;
        const { data: mem } = await admin
          .from('tenant_members')
          .select('tenant_id')
          .eq('user_id', user.id)
          .maybeSingle();
        if (mem) createdTenantId = mem.tenant_id as string;
      }

      // --- 2. Empty state ---
      await page.goto('/customers');
      await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /no customers yet/i })).toBeVisible();

      // --- 3. Create "Acme Supply" (commercial) ---
      await page.getByRole('link', { name: /add your first customer/i }).click();
      await page.waitForURL(/\/customers\/new$/);
      await page.getByLabel('Customer type').click();
      await page.getByRole('option', { name: 'Commercial' }).click();
      await page.getByLabel(/business name/i).fill('Acme Supply');
      await page.getByLabel('Email').fill('orders@acmesupply.com');
      await page.getByLabel('Phone').fill('604-555-0122');
      await page.getByLabel('Street address').fill('42 Industrial Way');
      await page.getByLabel('City').fill('Abbotsford');
      await page.getByLabel('Postal code').fill('V2S 1A1');
      await page.getByRole('button', { name: /create customer/i }).click();

      // Lands on detail page with the new customer's name + Commercial badge.
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Acme Supply' })).toBeVisible();
      await expect(page.getByText('Commercial').first()).toBeVisible();

      // --- 4. Back to list → row visible ---
      await page.getByRole('link', { name: /back to customers/i }).click();
      await page.waitForURL(/\/customers(\?.*)?$/);
      await expect(page.getByRole('link', { name: 'Acme Supply' })).toBeVisible({
        timeout: 5000,
      });

      // --- 5. Search "acme" → visible. "xyz" → empty state ---
      const searchbox = page.getByRole('searchbox', { name: /search customers/i });
      await searchbox.fill('acme');
      await expect(page.getByRole('link', { name: 'Acme Supply' })).toBeVisible({ timeout: 5000 });
      await searchbox.fill('xyznope');
      await expect(page.getByText(/no customers match that search/i)).toBeVisible({
        timeout: 5000,
      });

      // Clear and ensure the row returns.
      await page.getByRole('link', { name: /clear filters/i }).click();
      await page.waitForURL(/\/customers$/);
      await expect(page.getByRole('link', { name: 'Acme Supply' })).toBeVisible({
        timeout: 5000,
      });

      // --- 6. Type filter ---
      await page.getByRole('button', { name: 'Residential', exact: true }).click();
      await page.waitForURL(/type=residential/);
      await expect(page.getByText(/no customers match that search/i)).toBeVisible({
        timeout: 5000,
      });
      await page.getByRole('button', { name: 'Commercial', exact: true }).click();
      await page.waitForURL(/type=commercial/);
      await expect(page.getByRole('link', { name: 'Acme Supply' })).toBeVisible({
        timeout: 5000,
      });

      // --- 7. Click → detail ---
      await page.getByRole('link', { name: 'Acme Supply' }).click();
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: 'Acme Supply' })).toBeVisible();
      await expect(page.getByText('Commercial').first()).toBeVisible();

      // --- 8. Edit ---
      await page.getByRole('link', { name: /edit/i }).click();
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}\/edit$/);
      const nameField = page.getByLabel(/business name/i);
      await nameField.fill('Acme Supply Ltd');
      await page.getByRole('button', { name: /save changes/i }).click();
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: 'Acme Supply Ltd' })).toBeVisible();

      // --- 9. Delete ---
      await page.getByRole('button', { name: /^delete$/i }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: /^delete$/i }).click();

      await page.waitForURL(/\/customers\/?(\?.*)?$/, { timeout: 20_000 });
      // Account now has zero customers → fresh empty state returns.
      await expect(page.getByRole('heading', { name: /no customers yet/i })).toBeVisible();
    });
  });
