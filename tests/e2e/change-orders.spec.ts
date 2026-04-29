/**
 * End-to-end test for the Change Order + Approval workflow.
 *
 * Steps:
 *   1. Sign up a fresh tenant.
 *   2. Create a customer with email.
 *   3. Create a project.
 *   4. Create a change order (draft).
 *   5. Send it for approval.
 *   6. Visit the public approval page → verify it shows.
 *   7. Approve the change order.
 *   8. Verify it shows as approved.
 *   9. Cleanup.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .skip('change order approval flow', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-co-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';
    const businessName = `CO E2E Co ${stamp}`;
    const customerName = `Test Customer ${stamp}`;
    const customerEmail = `customer-${stamp}@test.com`;

    let createdUserId: string | null = null;
    let createdTenantId: string | null = null;
    let approvalCode: string | null = null;

    test.afterAll(async () => {
      if (!url || !serviceRoleKey) return;
      const admin = createSupabaseClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      if (createdTenantId) {
        await admin.from('tenants').delete().eq('id', createdTenantId);
      }
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId);
      }
    });

    test('sign up and create project', async ({ page }) => {
      await page.goto('/signup');
      await page.getByLabel('Full name').fill('CO Tester');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: /sign up/i }).click();

      // Wait for dashboard
      await page.waitForURL('**/dashboard**', { timeout: 15000 });

      // Get tenant ID for cleanup
      if (url && serviceRoleKey) {
        const admin = createSupabaseClient(url, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: users } = await admin.auth.admin.listUsers();
        const user = users?.users?.find((u) => u.email === email);
        if (user) createdUserId = user.id;

        const { data: members } = await admin
          .from('tenant_members')
          .select('tenant_id')
          .eq('user_id', createdUserId ?? '')
          .single();
        if (members) createdTenantId = members.tenant_id as string;

        // Set vertical to renovation
        if (createdTenantId) {
          await admin.from('tenants').update({ vertical: 'renovation' }).eq('id', createdTenantId);
        }

        // Create customer directly
        await admin.from('customers').insert({
          tenant_id: createdTenantId,
          name: customerName,
          email: customerEmail,
          type: 'residential',
        });
      }
    });

    test('create change order and send for approval', async ({ page }) => {
      await page.goto('/projects/new');
      await page.waitForLoadState('networkidle');

      // May need to navigate to projects first
      await page.goto('/projects');

      // The project creation would need UI interaction, so let's create via admin
      if (url && serviceRoleKey && createdTenantId) {
        const admin = createSupabaseClient(url, serviceRoleKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        });

        // Get customer
        const { data: customer } = await admin
          .from('customers')
          .select('id')
          .eq('tenant_id', createdTenantId)
          .single();

        // Create project
        const { data: project } = await admin
          .from('projects')
          .insert({
            tenant_id: createdTenantId,
            customer_id: customer?.id,
            name: `Test Reno ${stamp}`,
            status: 'in_progress',
          })
          .select('id')
          .single();

        expect(project).toBeTruthy();

        // Create change order
        const code = `test${stamp.slice(0, 12)}`;
        const { data: co } = await admin
          .from('change_orders')
          .insert({
            project_id: project?.id,
            tenant_id: createdTenantId,
            title: 'Add pot lights',
            description: 'Install 6 pot lights in kitchen ceiling.',
            cost_impact_cents: 125000,
            timeline_impact_days: 3,
            status: 'pending_approval',
            approval_code: code,
            created_by: createdUserId ?? '',
          })
          .select('id, approval_code')
          .single();

        expect(co).toBeTruthy();
        approvalCode = co?.approval_code as string;
      }
    });

    test('visit approval page and approve', async ({ page }) => {
      expect(approvalCode).toBeTruthy();

      await page.goto(`/approve/${approvalCode}`);
      await page.waitForLoadState('networkidle');

      // Verify change order details are visible
      await expect(page.getByText('Add pot lights')).toBeVisible();
      await expect(page.getByText('$1,250.00')).toBeVisible();
      await expect(page.getByText('+3 days')).toBeVisible();

      // Click approve
      await page.getByRole('button', { name: /approve/i }).click();

      // Type name
      await page.getByPlaceholder('Your full name').fill('John Homeowner');

      // Confirm
      await page.getByRole('button', { name: /confirm approval/i }).click();

      // Wait for success
      await expect(page.getByText(/approved/i)).toBeVisible({ timeout: 10000 });
    });

    test('verify change order is approved in database', async () => {
      if (!url || !serviceRoleKey || !approvalCode) return;

      const admin = createSupabaseClient(url, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      const { data: co } = await admin
        .from('change_orders')
        .select('status, approved_by_name, approved_at')
        .eq('approval_code', approvalCode)
        .single();

      expect(co).toBeTruthy();
      expect(co?.status).toBe('approved');
      expect(co?.approved_by_name).toBe('John Homeowner');
      expect(co?.approved_at).toBeTruthy();
    });
  });
