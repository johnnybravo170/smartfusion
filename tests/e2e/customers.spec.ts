/**
 * Customers CRUD against the seeded fixture.
 *
 * The seed ships a residential customer ("Jane Homeowner"). This
 * spec exercises the operator-facing CRUD surface around adding,
 * filtering, editing, and deleting customers — the most foundational
 * data flow in the app.
 *
 * Predecessor: tests/e2e/customers.spec.ts (skipped) walked through
 * signup-via-UI, which broke when we added the verification gate.
 * This rewrite uses the admin-client seed so it stays narrow about
 * what's actually being verified.
 */

import { expect, test } from '@playwright/test';
import { type SeededDemo, seedDemo, signInAsOwner, tearDownDemo } from './_helpers/seed-demo';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('customers CRUD', () => {
    test.skip(!canRun, 'requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    let seed: SeededDemo;

    test.beforeAll(async () => {
      seed = await seedDemo({ label: 'customers' });
    });

    test.afterAll(async () => {
      if (seed) await tearDownDemo(seed);
    });

    test('list shows seeded customer + filtering by type works', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto('/customers');

      await expect(page.getByRole('heading', { name: 'Customers', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Jane Homeowner' })).toBeVisible();

      // Type filter — Jane is residential, so filtering to commercial
      // should hide her.
      await page.getByRole('button', { name: 'Commercial', exact: true }).click();
      await page.waitForURL(/type=commercial/);
      await expect(page.getByText(/no customers match that search/i)).toBeVisible();

      // Back to residential — Jane reappears.
      await page.getByRole('button', { name: 'Residential', exact: true }).click();
      await page.waitForURL(/type=residential/);
      await expect(page.getByRole('link', { name: 'Jane Homeowner' })).toBeVisible();
    });

    test('create commercial customer → detail page reflects it', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto('/customers/new');

      // Customer type select → Commercial.
      await page.getByLabel('Customer type').click();
      await page.getByRole('option', { name: 'Commercial' }).click();
      await page.getByLabel(/business name/i).fill('Acme Supply');
      await page.getByLabel('Email').fill('orders@acmesupply.test');
      await page.getByLabel('Phone').fill('604-555-0122');
      await page.getByLabel('Street address').fill('42 Industrial Way');
      await page.getByLabel('City').fill('Abbotsford');
      await page.getByLabel('Postal code').fill('V2S 1A1');
      await page.getByRole('button', { name: /create customer/i }).click();

      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: 'Acme Supply' })).toBeVisible();
      await expect(page.getByText('Commercial').first()).toBeVisible();

      // DB cross-check.
      const { data: rows } = await seed.admin
        .from('customers')
        .select('id, name, type, email')
        .eq('tenant_id', seed.tenantId);
      const acme = rows?.find((r) => r.name === 'Acme Supply');
      expect(acme).toBeTruthy();
      expect(acme?.type).toBe('commercial');
      expect(acme?.email).toBe('orders@acmesupply.test');
    });

    test('search narrows the list correctly', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto('/customers');

      const searchbox = page.getByRole('searchbox', { name: /search customers/i });
      await searchbox.fill('acme');
      await expect(page.getByRole('link', { name: 'Acme Supply' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Jane Homeowner' })).not.toBeVisible();

      await searchbox.fill('homeowner');
      await expect(page.getByRole('link', { name: 'Jane Homeowner' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Acme Supply' })).not.toBeVisible();

      await searchbox.fill('xyznope');
      await expect(page.getByText(/no customers match that search/i)).toBeVisible();
    });

    test('edit + delete the commercial customer', async ({ page }) => {
      await signInAsOwner(page, seed);

      // Find Acme's id directly so we don't depend on UI navigation.
      const { data: acme } = await seed.admin
        .from('customers')
        .select('id')
        .eq('tenant_id', seed.tenantId)
        .eq('name', 'Acme Supply')
        .single();
      const acmeId = acme?.id as string;

      // Edit.
      await page.goto(`/customers/${acmeId}/edit`);
      await page.getByLabel(/business name/i).fill('Acme Supply Ltd');
      await page.getByRole('button', { name: /save changes/i }).click();
      await page.waitForURL(/\/customers\/[0-9a-f-]{36}$/);
      await expect(page.getByRole('heading', { name: 'Acme Supply Ltd' })).toBeVisible();

      // Delete via the confirm dialog.
      await page.getByRole('button', { name: /^delete$/i }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: /^delete$/i }).click();

      await page.waitForURL(/\/customers\/?(\?.*)?$/, { timeout: 20_000 });

      // Acme is gone — but the seeded Jane survives.
      await expect(page.getByRole('link', { name: 'Acme Supply Ltd' })).not.toBeVisible();
      await expect(page.getByRole('link', { name: 'Jane Homeowner' })).toBeVisible();

      const { data: stillThere } = await seed.admin
        .from('customers')
        .select('id, deleted_at')
        .eq('id', acmeId)
        .maybeSingle();
      // Customers use soft delete (deleted_at). Either soft-deleted
      // or hard-deleted — both satisfy "Acme is gone".
      expect(stillThere === null || stillThere.deleted_at !== null).toBe(true);
    });
  });
