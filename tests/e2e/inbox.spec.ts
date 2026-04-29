/**
 * End-to-end test for the Inbox (Track E) module.
 *
 * Signs up a fresh tenant, walks through the todo lifecycle and the work log
 * note flow, and verifies the search filter works. Skipped when service-role
 * credentials aren't available (we use the admin client for cleanup and for
 * sanity-checking tenant isolation).
 *
 * Steps (per PHASE_1_PLAN.md §8 Track E):
 *   1. Sign up a new tenant with a unique email.
 *   2. /inbox → todos tab default, empty state.
 *   3. Add todo "Call Sarah Chen about deck wash".
 *   4. Check the box → todo moves to Done section.
 *   5. Uncheck → back to Upcoming.
 *   6. Hover → delete icon → confirm → empty state.
 *   7. Switch to Work log tab (?tab=worklog) → empty state.
 *   8. Click "Add note" → dialog → fill title + body → submit.
 *   9. Dialog closes, entry appears.
 *   10. Search "customer" → entry still visible; search "nonexistentterm"
 *       → empty filtered state.
 *   11. Cleanup (afterAll): delete tenant + auth user.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .skip('inbox (todos + work log)', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-inbox-${stamp}@heyhenry.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Inbox E2E Co ${stamp}`;

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

    test('full inbox lifecycle: todos + work log', async ({ page }) => {
      // --- 1. Sign up ---
      await page.goto('/signup');
      await page.getByLabel('Business name').fill(businessName);
      await page.getByLabel('Email').fill(email);
      await page.getByLabel('Password').fill(password);
      await page.getByRole('button', { name: /create account/i }).click();
      await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

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

      // --- 2. Inbox with todos tab default, empty state ---
      await page.goto('/inbox');
      await expect(page.getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
      await expect(page.getByRole('tab', { name: /^todos/i })).toHaveAttribute(
        'data-state',
        'active',
      );
      await expect(page.getByText(/nothing on your list right now/i)).toBeVisible();

      // --- 3. Add todo ---
      const todoTitle = 'Call Sarah Chen about deck wash';
      await page.getByPlaceholder('Add a todo…').fill(todoTitle);
      await page.getByRole('button', { name: /^add$/i }).click();

      // Todo appears in Upcoming
      const todoItem = page.locator('[data-slot="todo-item"]', { hasText: todoTitle });
      await expect(todoItem).toBeVisible({ timeout: 10_000 });

      // --- 4. Check the box → moves to Done (collapsed section, verify via DB) ---
      await todoItem.getByRole('checkbox').click();
      await expect
        .poll(
          async () => {
            const { data: rows } = await admin
              .from('todos')
              .select('id, done, title')
              .eq('tenant_id', createdTenantId as string);
            const row = (rows ?? []).find((r) =>
              (r as { title?: string }).title?.includes('Call Sarah Chen'),
            );
            return (row as { done?: boolean })?.done;
          },
          { timeout: 10_000, intervals: [500, 500, 1000] },
        )
        .toBe(true);

      // --- 5. Uncheck → back to not done ---
      // Expand the Done section so the item is reachable, then toggle it.
      await page.getByRole('button', { name: /^done/i }).click();
      await todoItem.getByRole('checkbox').click();
      await expect
        .poll(
          async () => {
            const { data: rows } = await admin
              .from('todos')
              .select('id, done, title')
              .eq('tenant_id', createdTenantId as string);
            const row = (rows ?? []).find((r) =>
              (r as { title?: string }).title?.includes('Call Sarah Chen'),
            );
            return (row as { done?: boolean })?.done;
          },
          { timeout: 10_000, intervals: [500, 500, 1000] },
        )
        .toBe(false);

      // --- 6. Delete → empty state ---
      await todoItem.hover();
      await todoItem.getByRole('button', { name: /delete todo/i }).click();
      const confirmDialog = page.getByRole('alertdialog');
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(page.getByText(/nothing on your list right now/i)).toBeVisible({
        timeout: 10_000,
      });

      // --- 7. Switch to work log tab ---
      await page.getByRole('tab', { name: /work log/i }).click();
      await page.waitForURL(/\?tab=worklog/);
      await expect(page.getByRole('tab', { name: /work log/i })).toHaveAttribute(
        'data-state',
        'active',
      );

      // Either empty state or no entries — fresh tenant has no worklog yet.
      await expect(page.getByText(/no entries yet/i)).toBeVisible();

      // --- 8. Add note dialog ---
      await page.getByRole('button', { name: /add note/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Title').fill('Customer visit notes');
      await dialog.getByLabel('Body').fill('Discussed deck project with Sarah.');
      await dialog.getByRole('button', { name: /save note/i }).click();

      // --- 9. Dialog closes, entry appears ---
      await expect(dialog).toBeHidden({ timeout: 10_000 });
      await expect(page.getByRole('heading', { name: 'Customer visit notes' })).toBeVisible({
        timeout: 10_000,
      });

      // --- 10. Search ---
      await page.getByPlaceholder('Search work log…').fill('customer');
      await expect(page.getByRole('heading', { name: 'Customer visit notes' })).toBeVisible({
        timeout: 10_000,
      });

      await page.getByPlaceholder('Search work log…').fill('');
      await page.getByPlaceholder('Search work log…').fill('zzzzznonexistentterm');
      await expect(page.getByText(/no entries match these filters/i)).toBeVisible({
        timeout: 10_000,
      });
    });
  });
