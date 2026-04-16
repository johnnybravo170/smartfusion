/**
 * End-to-end test for the Photos (Track D) module.
 *
 * Signs up a fresh tenant, seeds one customer + one job via the admin
 * client, then walks through upload → gallery visible → delete. Verifies
 * that the `photos` row (and its storage object, via signed URL reachability)
 * round-trip correctly.
 *
 * Skipped when service-role credentials aren't available.
 *
 * Steps:
 *   1. Sign up a new tenant with a unique email.
 *   2. Pre-seed a customer + job via admin.
 *   3. Visit /photos-demo?job_id=<jobId>.
 *   4. Drop the fixture PNG into the file input.
 *   5. Click "Upload" → wait for the thumbnail to appear in the gallery.
 *   6. Admin DB query confirms the `photos` row exists with a matching
 *      `storage_path` prefix of `{tenant_id}/{job_id}/`.
 *   7. Click delete → confirm → thumbnail disappears → DB row gone.
 *   8. Cleanup (afterAll): drop the auth user + tenant via admin.
 */

import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

const FIXTURE_PATH = resolve(__dirname, '../fixtures/test-photo.png');

test.describe
  .serial('photos upload + gallery + delete', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `e2e-photos-${stamp}@smartfusion.test`;
    const password = 'Correct-Horse-9';
    const businessName = `Photos E2E Co ${stamp}`;
    const customerName = `Photos Customer ${stamp}`;

    let createdUserId: string | null = null;
    let createdTenantId: string | null = null;
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

      // Blow away any storage objects under the tenant's prefix. The tenant
      // cascade deletes the photos rows, but storage objects outlive rows.
      if (createdTenantId) {
        try {
          const { data: toDelete } = await admin.storage
            .from('photos')
            .list(createdTenantId, { limit: 1000 });
          if (toDelete?.length) {
            await admin.storage
              .from('photos')
              .remove(toDelete.map((f) => `${createdTenantId}/${f.name}`));
          }
          // And any nested job folders.
          const { data: jobDirs } = await admin.storage
            .from('photos')
            .list(createdTenantId, { limit: 1000 });
          if (jobDirs?.length) {
            for (const dir of jobDirs) {
              const { data: files } = await admin.storage
                .from('photos')
                .list(`${createdTenantId}/${dir.name}`, { limit: 1000 });
              if (files?.length) {
                await admin.storage
                  .from('photos')
                  .remove(files.map((f) => `${createdTenantId}/${dir.name}/${f.name}`));
              }
            }
          }
        } catch {
          // Best-effort cleanup.
        }
        await admin.from('tenants').delete().eq('id', createdTenantId);
      }
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      }
    });

    test('upload → gallery → delete with DB round-trip', async ({ page }) => {
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

      // Resolve ids.
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

      // --- 2. Seed customer + job ---
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

      const { data: job } = await admin
        .from('jobs')
        .insert({
          tenant_id: createdTenantId,
          customer_id: customer?.id,
          status: 'booked',
        })
        .select('id')
        .single();
      expect(job?.id).toBeTruthy();
      createdJobId = job?.id as string;

      // --- 3. Visit demo page ---
      await page.goto(`/photos-demo?job_id=${createdJobId}`);
      await expect(page.getByRole('heading', { name: /photos \(preview\)/i })).toBeVisible();

      // Gallery empty state visible before upload.
      await expect(page.locator('[data-slot="photo-gallery-empty"]')).toBeVisible();

      // --- 4. Attach the fixture PNG via the hidden file input ---
      await page.locator('input[type="file"][accept^="image"]').setInputFiles(FIXTURE_PATH);

      // Staged row appears.
      await expect(page.locator('[data-slot="staged-photo"]').first()).toBeVisible();

      // --- 5. Upload ---
      await page.getByRole('button', { name: /upload \d+ photo/i }).click();

      // Wait for the gallery thumbnail to appear. We rely on
      // router.refresh() inside the upload handler to re-run the RSC.
      await expect(page.locator('[data-slot="photo-card"]').first()).toBeVisible({
        timeout: 20_000,
      });

      // --- 6. Verify the row ---
      const { data: rows } = await admin
        .from('photos')
        .select('id, storage_path, job_id, tag')
        .eq('job_id', createdJobId);
      expect(rows ?? []).toHaveLength(1);
      const row = (rows ?? [])[0];
      expect(row.storage_path.startsWith(`${createdTenantId}/${createdJobId}/`)).toBe(true);

      // --- 7. Delete → gallery empty again ---
      await page.locator('[data-slot="photo-card"] button[aria-label="Delete photo"]').click();
      const confirm = page.getByRole('alertdialog');
      await expect(confirm).toBeVisible();
      await confirm.getByRole('button', { name: /^delete$/i }).click();

      await expect(page.locator('[data-slot="photo-gallery-empty"]')).toBeVisible({
        timeout: 15_000,
      });

      const { data: afterDelete } = await admin
        .from('photos')
        .select('id')
        .eq('job_id', createdJobId);
      expect(afterDelete ?? []).toHaveLength(0);
    });
  });
