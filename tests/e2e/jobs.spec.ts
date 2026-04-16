/**
 * End-to-end test for the Jobs (Track C) module.
 *
 * Signs up a fresh tenant, seeds a customer via the admin client (UI flow
 * is covered in Track A's spec), then walks through create → status-change
 * → board → delete. Verifies that a worklog entry is written on status
 * change. Skipped when service-role credentials aren't available.
 *
 * Steps (per PHASE_1_PLAN.md §8 Track C):
 *   1. Sign up a new tenant with a unique email.
 *   2. Pre-seed ONE customer via admin client.
 *   3. Visit /jobs → empty state.
 *   4. Click "New job" → form → pick customer → status "booked" → scheduled
 *      next Tuesday → submit.
 *   5. Redirected to /jobs/[id], status badge "Booked" visible.
 *   6. Change status to "in_progress" via select → badge updates → toast.
 *   7. Verify via admin DB: worklog_entries has 1 row for this job with
 *      entry_type='system'.
 *   8. Navigate to /jobs board → job card in the "In progress" column.
 *   9. Delete → confirm → back to /jobs → empty state.
 *  10. Cleanup (afterAll): drop the auth user + tenant via admin client.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('jobs CRUD + status workflow', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-jobs-${stamp}@smartfusion.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Jobs E2E Co ${stamp}`;
    const customerName = `Jobs Customer ${stamp}`;

    let createdUserId: string | null = null;
    let createdTenantId: string | null = null;
    let createdCustomerId: string | null = null;
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

    test('full job lifecycle with worklog logging', async ({ page }) => {
      // --- 1. Sign up ---
      await page.goto('/signup');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

      // Capture ids + seed a customer via admin client.
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
      createdCustomerId = customer?.id as string;

      // --- 2/3. Empty state on /jobs ---
      await page.goto('/jobs');
      await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: /no jobs yet/i })).toBeVisible();

      // --- 4. Click "New job" → form → submit ---
      await page.getByRole('link', { name: /schedule a job/i }).click();
      await page.waitForURL(/\/jobs\/new$/);

      // Customer picker — native select doesn't exist because we use shadcn
      // Select which renders a listbox. Click + pick option.
      await page.getByLabel('Customer').click();
      await page.getByRole('option', { name: customerName }).click();

      // Status should default to Booked; don't touch it.
      // Set scheduled date to a few days from now.
      const next = new Date();
      next.setDate(next.getDate() + 7);
      next.setHours(9, 0, 0, 0);
      const pad = (n: number) => n.toString().padStart(2, '0');
      const datetimeLocal = `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
      await page.getByLabel(/scheduled for/i).fill(datetimeLocal);

      await page.getByRole('button', { name: /create job/i }).click();

      // --- 5. Redirected to /jobs/[id] with Booked badge ---
      await page.waitForURL(/\/jobs\/[0-9a-f-]{36}$/, { timeout: 20_000 });
      const urlMatch = page.url().match(/\/jobs\/([0-9a-f-]{36})$/);
      expect(urlMatch).toBeTruthy();
      createdJobId = urlMatch?.[1] ?? null;

      await expect(page.getByRole('heading', { name: customerName })).toBeVisible();
      // Status badge shows "Booked"
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText('Booked');

      // --- 6. Change status to In progress via select ---
      await page.getByLabel('Change job status').click();
      await page.getByRole('option', { name: 'In progress' }).click();

      // Wait for the badge to reflect the change (page revalidates).
      await expect(page.locator('[data-slot="job-status-badge"]').first()).toHaveText(
        /in progress/i,
        { timeout: 10_000 },
      );

      // --- 7. Verify worklog entry written ---
      const { data: logs } = await admin
        .from('worklog_entries')
        .select('id, entry_type, title, body, related_type, related_id')
        .eq('related_type', 'job')
        .eq('related_id', createdJobId as string);
      expect(logs ?? []).toHaveLength(1);
      expect((logs ?? [])[0].entry_type).toBe('system');
      expect((logs ?? [])[0].body).toMatch(/in progress/i);

      // --- 8. Board view shows card in In progress column ---
      await page.goto('/jobs');
      await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
      const inProgressCol = page.getByTestId('board-column-in_progress');
      await expect(inProgressCol.getByText(customerName)).toBeVisible({ timeout: 10_000 });

      // --- 9. Delete → back to empty state ---
      await page.goto(`/jobs/${createdJobId}`);
      await page.getByRole('button', { name: /^delete$/i }).click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: /^delete$/i }).click();

      await page.waitForURL(/\/jobs\/?(\?.*)?$/, { timeout: 20_000 });
      await expect(page.getByRole('heading', { name: /no jobs yet/i })).toBeVisible();

      // Silence unused-var warnings.
      void createdCustomerId;
    });
  });
