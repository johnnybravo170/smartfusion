/**
 * End-to-end test for the public lead-gen quoting widget (Issue #19).
 *
 * Flow:
 *   1. Seed a tenant with a slug + catalog entries via admin client
 *   2. Visit /q/{slug} — public page loads, no auth required
 *   3. Switch to manual entry, add a surface
 *   4. Click "Get your estimate" to advance to contact form
 *   5. Fill in contact form: name, email, phone
 *   6. Submit
 *   7. Verify confirmation screen
 *   8. Verify via admin DB: customer created in the tenant, draft quote with surfaces
 *   9. Cleanup
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .skip('lead-gen: public quote widget captures leads', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slug = `e2e-lead-${stamp}`.slice(0, 50).replace(/[^a-z0-9-]/g, '');
    const businessName = `Lead Gen E2E Co ${stamp}`;
    const leadName = 'Jane Homeowner';
    const leadEmail = `jane-${stamp}@example.com`;
    const leadPhone = '604-555-1234';

    let createdTenantId: string | null = null;
    let createdUserId: string | null = null;

    test.afterAll(async () => {
      if (!canRun) return;
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      if (createdTenantId) {
        // Clean up in order: quote_surfaces → quotes → customers → catalog → todos → worklog → tenant_members → tenant → user
        const { data: quotes } = await admin
          .from('quotes')
          .select('id')
          .eq('tenant_id', createdTenantId);
        for (const q of quotes ?? []) {
          await admin.from('quote_surfaces').delete().eq('quote_id', q.id);
        }
        await admin.from('quotes').delete().eq('tenant_id', createdTenantId);
        await admin.from('customers').delete().eq('tenant_id', createdTenantId);
        await admin.from('catalog_items').delete().eq('tenant_id', createdTenantId);
        await admin.from('todos').delete().eq('tenant_id', createdTenantId);
        await admin.from('worklog_entries').delete().eq('tenant_id', createdTenantId);
        await admin.from('tenant_members').delete().eq('tenant_id', createdTenantId);
        await admin.from('tenants').delete().eq('id', createdTenantId);
      }
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      }
    });

    test('public quote flow: add surface, submit contact, verify lead created', async ({
      page,
    }) => {
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // --- 1. Seed tenant + user + catalog via admin ---
      // Create a test user (needed for tenant_members FK).
      const testEmail = `e2e-operator-${stamp}@heyhenry.test`;
      const { data: authUser } = await admin.auth.admin.createUser({
        email: testEmail,
        password: 'Test-Password-123',
        email_confirm: true,
      });
      if (!authUser?.user?.id) throw new Error('Failed to create test user');
      createdUserId = authUser.user.id;

      // Create tenant with slug.
      const { data: tenant } = await admin
        .from('tenants')
        .insert({ name: businessName, slug })
        .select('id')
        .single();
      if (!tenant?.id) throw new Error('Failed to create test tenant');
      createdTenantId = tenant.id as string;

      // Link user to tenant.
      await admin.from('tenant_members').insert({
        tenant_id: createdTenantId,
        user_id: createdUserId,
        role: 'owner',
      });

      // Seed pricebook entries (per_unit/sqft items for the map quote flow).
      await admin.from('catalog_items').insert([
        {
          tenant_id: createdTenantId,
          name: 'Driveway',
          surface_type: 'driveway',
          pricing_model: 'per_unit',
          unit_label: 'sqft',
          unit_price_cents: 15,
          min_charge_cents: 5000,
          category: 'service',
          is_taxable: true,
          is_active: true,
        },
        {
          tenant_id: createdTenantId,
          name: 'House Siding',
          surface_type: 'siding',
          pricing_model: 'per_unit',
          unit_label: 'sqft',
          unit_price_cents: 25,
          min_charge_cents: 7500,
          category: 'service',
          is_taxable: true,
          is_active: true,
        },
      ]);

      // --- 2. Visit public page ---
      await page.goto(`/q/${slug}`);
      await expect(page.getByRole('heading', { name: businessName })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('Get an instant estimate')).toBeVisible();

      // --- 3. Switch to manual entry + add surface ---
      await page.getByRole('button', { name: /enter manually/i }).click();

      // Select driveway type and enter sqft.
      await page.locator('button[role="combobox"]').first().click();
      await page.getByRole('option', { name: 'Driveway' }).click();
      await page.getByPlaceholder('0.0').fill('500');
      await page.getByRole('button', { name: /^add$/i }).click();

      // Verify surface appears in list.
      await expect(page.getByText('500.0')).toBeVisible();
      // 500 * $0.15 = $75.00
      await expect(page.getByText('$75.00')).toBeVisible();

      // --- 4. Click "Get your estimate" ---
      await page.getByRole('button', { name: /get your estimate/i }).click();

      // --- 5. Fill in contact form ---
      await expect(page.getByText('Your contact details')).toBeVisible();
      await page.getByLabel('Name *').fill(leadName);
      await page.getByLabel('Email *').fill(leadEmail);
      await page.getByLabel('Phone *').fill(leadPhone);

      // --- 6. Submit ---
      await page.getByRole('button', { name: /^submit$/i }).click();

      // --- 7. Verify confirmation ---
      await expect(page.getByText('Thanks!')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(businessName)).toBeVisible();
      await expect(page.getByText('Your quote has been saved')).toBeVisible();

      // --- 8. Verify in DB ---
      // Check customer was created.
      const { data: customers } = await admin
        .from('customers')
        .select('id, name, email, phone')
        .eq('tenant_id', createdTenantId)
        .eq('email', leadEmail);
      expect(customers).toHaveLength(1);
      const customer = customers?.[0];
      if (!customer) throw new Error('Customer not found');
      expect(customer.name).toBe(leadName);
      expect(customer.phone).toBe(leadPhone);

      // Check draft quote was created.
      const { data: quotes } = await admin
        .from('quotes')
        .select('id, status, customer_id, total_cents')
        .eq('tenant_id', createdTenantId)
        .eq('customer_id', customer.id);
      expect(quotes).toHaveLength(1);
      const quote = quotes?.[0];
      if (!quote) throw new Error('Quote not found');
      expect(quote.status).toBe('draft');
      // 500sqft * 15 cents = $75 subtotal + $3.75 GST = $78.75 = 7875 cents
      expect(quote.total_cents).toBe(7875);

      // Check quote surfaces.
      const { data: surfaces } = await admin
        .from('quote_surfaces')
        .select('surface_type, sqft, price_cents')
        .eq('quote_id', quote.id);
      expect(surfaces).toHaveLength(1);
      const surface = surfaces?.[0];
      if (!surface) throw new Error('Surface not found');
      expect(surface.surface_type).toBe('driveway');
      expect(surface.sqft).toBe(500);
      expect(surface.price_cents).toBe(7500);

      // Check worklog entry was created.
      const { data: worklog } = await admin
        .from('worklog_entries')
        .select('title')
        .eq('tenant_id', createdTenantId)
        .eq('related_id', quote.id);
      expect(worklog?.length).toBeGreaterThanOrEqual(1);

      // Check todo was created.
      const { data: todos } = await admin
        .from('todos')
        .select('title')
        .eq('tenant_id', createdTenantId)
        .ilike('title', `%${leadName}%`);
      expect(todos?.length).toBeGreaterThanOrEqual(1);
    });
  });
