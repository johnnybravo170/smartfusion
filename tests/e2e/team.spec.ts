/**
 * End-to-end test: worker invite flow.
 *
 *   1. Owner signs up and creates a tenant
 *   2. Owner navigates to Settings > Team and generates an invite link
 *   3. Worker opens the invite link and signs up
 *   4. Owner sees the worker in the team members list
 *   5. Owner removes the worker
 *
 * Cleanup: deletes auth users and tenant via the admin client.
 *
 * Skipped when service-role key is not available.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe('worker invite flow', () => {
  test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

  const ownerEmail = `e2e-owner-${Date.now()}@test.local`;
  const ownerPassword = 'TestPass123';
  const businessName = `E2E Team Test ${Date.now()}`;

  const workerEmail = `e2e-worker-${Date.now()}@test.local`;
  const workerPassword = 'WorkerPass123';
  const workerName = 'Test Worker';

  let tenantId: string | undefined;
  let ownerUserId: string | undefined;
  let workerUserId: string | undefined;

  test.afterAll(async () => {
    if (!url || !serviceRoleKey) return;
    const admin = createSupabaseClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Clean up users.
    if (workerUserId) await admin.auth.admin.deleteUser(workerUserId).catch(() => {});
    if (ownerUserId) await admin.auth.admin.deleteUser(ownerUserId).catch(() => {});
    // Clean up tenant (cascades tenant_members and worker_invites).
    if (tenantId) {
      try {
        await admin.from('tenants').delete().eq('id', tenantId);
      } catch {
        /* best-effort */
      }
    }
  });

  test('owner creates invite, worker joins, owner removes worker', async ({ page, context }) => {
    // 1. Owner signs up.
    await page.goto('/signup');
    await page.fill('[name="businessName"]', businessName);
    await page.fill('[name="email"]', ownerEmail);
    await page.fill('[name="password"]', ownerPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 15_000 });

    // Grab tenant ID from the admin client for cleanup.
    const admin = createSupabaseClient(url!, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: ownerUser } = await admin.auth.admin.listUsers();
    const owner = ownerUser?.users.find((u) => u.email === ownerEmail);
    ownerUserId = owner?.id;

    if (ownerUserId) {
      const { data: memberData } = await admin
        .from('tenant_members')
        .select('tenant_id')
        .eq('user_id', ownerUserId)
        .single();
      tenantId = memberData?.tenant_id;
    }

    // 2. Navigate to Settings > Team.
    await page.goto('/settings/team');
    await page.waitForSelector('text=Invite a Worker', { timeout: 10_000 });

    // 3. Generate invite link.
    await page.click('text=Generate invite link');
    const inviteLinkEl = await page.waitForSelector('code', { timeout: 10_000 });
    const inviteLink = await inviteLinkEl.textContent();
    expect(inviteLink).toBeTruthy();
    expect(inviteLink).toContain('/join/');

    // 4. Worker opens the invite link in a new context (simulates incognito).
    const workerContext = await context.browser()?.newContext();
    const workerPage = await workerContext.newPage();

    // Extract the path from the invite link.
    const joinPath = new URL(inviteLink!).pathname;
    await workerPage.goto(joinPath);
    await workerPage.waitForSelector(`text=${businessName}`, { timeout: 10_000 });

    // 5. Worker fills in signup form.
    await workerPage.fill('[name="name"]', workerName);
    await workerPage.fill('[name="email"]', workerEmail);
    await workerPage.fill('[name="password"]', workerPassword);
    await workerPage.click('button[type="submit"]');
    await workerPage.waitForURL('**/dashboard', { timeout: 15_000 });

    // Grab worker user ID for cleanup.
    const { data: workerUsers } = await admin.auth.admin.listUsers();
    const worker = workerUsers?.users.find((u) => u.email === workerEmail);
    workerUserId = worker?.id;

    await workerContext.close();

    // 6. Owner reloads team page and sees the worker.
    await page.goto('/settings/team');
    await page.waitForSelector(`text=${workerEmail}`, { timeout: 10_000 });

    // 7. Owner removes the worker.
    const workerRow = page.locator('tr', { hasText: workerEmail });
    await workerRow.locator('button').first().click();
    // Confirm in the AlertDialog.
    await page.click('text=Remove');

    // Verify the worker is gone.
    await expect(page.locator(`text=${workerEmail}`)).toHaveCount(0, { timeout: 5_000 });
  });
});
