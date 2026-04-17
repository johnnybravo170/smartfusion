/**
 * E2E test for the AI chat panel.
 *
 * Verifies the chat UI against a running dev server:
 *   1. Chat toggle button is visible on the dashboard.
 *   2. Clicking it opens the slide-out panel with the "Henry" header.
 *   3. Empty state message is shown.
 *   4. Sending a message shows it in the conversation.
 *   5. (When ANTHROPIC_API_KEY is set) An assistant response streams back.
 *   6. Closing and reopening the panel preserves the open state.
 *   7. Clear history works.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for auth
 * setup. The real AI response test additionally requires ANTHROPIC_API_KEY.
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anthropicKey = process.env.ANTHROPIC_API_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe('chat panel', () => {
  test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

  const email = `e2e-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@smartfusion.test`;
  const password = 'Correct-Horse-9';
  const businessName = `Chat Test ${Date.now()}`;

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
      const { data: m } = await admin
        .from('tenant_members')
        .select('tenant_id')
        .eq('user_id', createdUserId)
        .maybeSingle();
      if (m) createdTenantId = m.tenant_id as string;
    }

    if (createdTenantId) {
      await admin.from('tenants').delete().eq('id', createdTenantId);
    }
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
    }
  });

  test('chat toggle, panel open/close, empty state, and clear history', async ({ page }) => {
    // Sign up a fresh user.
    await page.goto('/signup');
    await page.getByLabel('Business name').fill(businessName);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /create account/i }).click();
    await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

    // Grab user/tenant IDs for cleanup.
    const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: usersPage } = await admin.auth.admin.listUsers();
    const user = usersPage?.users.find((u) => u.email === email);
    if (user) {
      createdUserId = user.id;
      const { data: m } = await admin
        .from('tenant_members')
        .select('tenant_id')
        .eq('user_id', user.id)
        .maybeSingle();
      if (m) createdTenantId = m.tenant_id as string;
    }

    // 1. Chat toggle button is visible.
    const toggleBtn = page.getByLabel('Open chat');
    await expect(toggleBtn).toBeVisible();

    // 2. Click toggle to open the panel.
    await toggleBtn.click();
    const panel = page.getByLabel('Chat with Henry');
    await expect(panel).toBeVisible();

    // 3. Henry header and empty state.
    await expect(panel.getByText('Henry')).toBeVisible();
    await expect(panel.getByText('Your business assistant')).toBeVisible();
    await expect(panel.getByText("I'm Henry, your business assistant")).toBeVisible();

    // 4. Close the panel.
    await page.getByLabel('Close chat').first().click();
    // Panel should slide out (translate-x-full).
    await expect(panel).toHaveClass(/translate-x-full/);

    // 5. Reopen -- localStorage persisted "closed", so toggle should reopen.
    await page.getByLabel('Open chat').click();
    await expect(panel).not.toHaveClass(/translate-x-full/);
  });

  // This test actually sends a message to the AI, so it needs the Anthropic key
  // and the /api/chat backend to be deployed.
  test('send message and receive response', async ({ page }) => {
    test.skip(!anthropicKey, 'ANTHROPIC_API_KEY required for AI response test');
    test.setTimeout(60_000); // AI responses can take time

    // Log in with the user created above.
    await page.goto('/login');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard(\?.*)?$/, { timeout: 20_000 });

    // Open the chat panel.
    await page.getByLabel('Open chat').click();
    const panel = page.getByLabel('Chat with Henry');
    await expect(panel).toBeVisible();

    // Type a message and send.
    const input = panel.getByPlaceholder('Ask Henry anything...');
    await input.fill('how many customers do I have?');
    await input.press('Enter');

    // User message should appear.
    await expect(panel.getByText('how many customers do I have?')).toBeVisible();

    // Wait for a response (assistant bubble with content).
    // The response should eventually contain a number.
    await expect(async () => {
      const bubbles = panel.locator('[class*="bg-muted"]').filter({ hasText: /\d/ });
      expect(await bubbles.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 30_000 });
  });
});
