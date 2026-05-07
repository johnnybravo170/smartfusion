/**
 * Change Orders v2 (line-diff form) end-to-end against the seeded fixture.
 *
 * Covers the recently-shipped flow:
 *   1. /projects/[id]/change-orders/new defaults to the v2 diff form
 *      (a recent flip — was opt-in via ?v2=1).
 *   2. Operator edits an existing line, sees a live delta badge, fills
 *      title/description, clicks "Save & Preview".
 *   3. The form lands on the CO detail page (NOT the list) so the
 *      operator can review before customer-facing send fires. This is
 *      the "always preview before send" rule.
 *   4. The DB row is flow_version=2, status=draft, with the line-diff
 *      stored in change_order_lines.
 */

import { expect, test } from '@playwright/test';
import { type SeededDemo, seedDemo, signInAsOwner, tearDownDemo } from './_helpers/seed-demo';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('change orders v2', () => {
    test.skip(!canRun, 'requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    let seed: SeededDemo;

    test.beforeAll(async () => {
      seed = await seedDemo({ label: 'co-v2' });
    });

    test.afterAll(async () => {
      if (seed) await tearDownDemo(seed);
    });

    test('diff form is default; "Save & Preview" lands on CO detail with v2 row', async ({
      page,
    }) => {
      await signInAsOwner(page, seed);
      await page.goto(`/projects/${seed.projectId}/change-orders/new`);

      // Title + description.
      await page.getByLabel('Title').fill('Add pot lights');
      await page.getByLabel('Description').fill('Install 6 LED pot lights in kitchen.');

      // Categories with no edits collapse by default (PR #84 — only
      // auto-expand categories that are part of this CO). Expand the
      // Cabinets category so the existing line input mounts. The
      // category-name cell is itself a button that toggles open
      // (PR #87's table layout — sibling to the chevron button).
      await page.getByRole('button', { name: /^Cabinets/ }).click();

      // Existing Cabinets line: qty=1, unit_price=$13,000. Unmodified
      // lines render in a compact view (PR #87) where qty/price are
      // buttons, not inputs — click the price to enter edit mode, then
      // the inputs mount. Pick the unit-price input (second number
      // input in the row) and bump to $14,500 — a +$1,500 modification.
      const shakerRow = page.locator('tr', { hasText: 'Shaker uppers' });
      await shakerRow.getByTitle('Click to edit price').click();
      await shakerRow.locator('input[type="number"]').nth(1).fill('14500');

      // Live delta should now show +$1,500 (regression check on the
      // running total computation).
      await expect(page.getByText(/\+\$1,500\.00/).first()).toBeVisible();

      // Submit. Goes to /projects/[id]/change-orders/[coId] (detail
      // page) — the "Save & Preview" rule.
      await page.getByRole('button', { name: /save & preview/i }).click();
      await page.waitForURL(/\/projects\/[0-9a-f-]{36}\/change-orders\/[0-9a-f-]{36}$/, {
        timeout: 20_000,
      });

      // DB: row exists, flow_version=2, status=draft, has at least one
      // change_order_line for the modify. cost_impact_cents matches the
      // delta we typed.
      const { data: co } = await seed.admin
        .from('change_orders')
        .select('id, status, flow_version, cost_impact_cents, title')
        .eq('project_id', seed.projectId)
        .single();
      expect(co).toBeTruthy();
      expect(co?.flow_version).toBe(2);
      expect(co?.status).toBe('draft');
      expect(co?.title).toBe('Add pot lights');
      expect(co?.cost_impact_cents).toBe(150000);

      const { data: lines } = await seed.admin
        .from('change_order_lines')
        .select('action, line_price_cents')
        .eq('change_order_id', co?.id as string);
      expect(lines?.length).toBeGreaterThanOrEqual(1);
      const modifyLine = (lines ?? []).find((l) => l.action === 'modify');
      expect(modifyLine).toBeTruthy();
      expect(modifyLine?.line_price_cents).toBe(1450000);
    });

    test('detail page Send for Approval moves CO to pending_approval', async ({ page }) => {
      // Pull the CO id we just created.
      const { data: co } = await seed.admin
        .from('change_orders')
        .select('id')
        .eq('project_id', seed.projectId)
        .single();

      await signInAsOwner(page, seed);
      await page.goto(`/projects/${seed.projectId}/change-orders/${co?.id}`);

      await page.getByRole('button', { name: /send for approval/i }).click();

      // Server action revalidates; status badge flips. Poll DB rather
      // than UI to avoid waiting on the realtime subscription.
      await expect
        .poll(
          async () => {
            const { data } = await seed.admin
              .from('change_orders')
              .select('status, approval_code')
              .eq('id', co?.id as string)
              .single();
            return data?.status;
          },
          { timeout: 10_000 },
        )
        .toBe('pending_approval');

      // The /approve/[code] page should now render with the title.
      const { data: pending } = await seed.admin
        .from('change_orders')
        .select('approval_code')
        .eq('id', co?.id as string)
        .single();
      expect(pending?.approval_code).toBeTruthy();

      await page.goto(`/approve/${pending?.approval_code}`);
      await expect(page.getByText('Add pot lights')).toBeVisible();
      await expect(page.getByText(/cost impact/i)).toBeVisible();
    });
  });
