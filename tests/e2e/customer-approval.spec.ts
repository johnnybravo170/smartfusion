/**
 * Customer-facing CO approval round-trip — the highest-blast-radius
 * surface in HeyHenry.
 *
 * The seeded fixture gets a v2 CO in pending_approval status. A
 * Playwright browser (no auth — public route) visits the approval
 * link, types the homeowner's name, confirms. After the round-trip:
 *
 *   - change_orders row: status='approved', approved_at + applied_at
 *     populated, approved_by_name set.
 *   - applyV2ChangeOrderDiff has run: the modified line's
 *     line_price_cents now reflects the CO's "after" amount.
 *   - Subsequent visits to /approve/[code] short-circuit to the
 *     "Already Approved" view.
 *
 * Decline path: covered as a separate test with a fresh CO.
 */

import { expect, test } from '@playwright/test';
import { type SeededDemo, seedDemo, tearDownDemo } from './_helpers/seed-demo';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

async function seedPendingV2Co(seed: SeededDemo, opts: { newPriceCents: number }) {
  // Owner user id — needed for change_orders.created_by NOT NULL.
  const { data: tenantRow } = await seed.admin
    .from('tenant_members')
    .select('user_id')
    .eq('tenant_id', seed.tenantId)
    .eq('role', 'owner')
    .single();
  const ownerUserId = tenantRow?.user_id as string;

  const approvalCode = `e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const cabinetsLineId = seed.costLineIds[0];
  const cabinetsCatId = seed.budgetCategoryIdsByName.Cabinets;
  // Seeded line: unit_price_cents=1300000, line_price_cents=1300000.
  const beforePriceCents = 1300000;
  const deltaCents = opts.newPriceCents - beforePriceCents;

  const { data: co } = await seed.admin
    .from('change_orders')
    .insert({
      tenant_id: seed.tenantId,
      project_id: seed.projectId,
      title: 'Upgrade cabinet hardware',
      description: 'Soft-close hinges + brushed brass handles.',
      cost_impact_cents: deltaCents,
      timeline_impact_days: 0,
      status: 'pending_approval',
      flow_version: 2,
      approval_code: approvalCode,
      created_by: ownerUserId,
    })
    .select('id')
    .single();
  const coId = co?.id as string;

  await seed.admin.from('change_order_lines').insert({
    tenant_id: seed.tenantId,
    change_order_id: coId,
    action: 'modify',
    original_line_id: cabinetsLineId,
    budget_category_id: cabinetsCatId,
    category: 'material',
    label: 'Shaker uppers + lowers',
    qty: 1,
    unit: 'set',
    unit_cost_cents: 900000,
    unit_price_cents: opts.newPriceCents,
    line_cost_cents: 900000,
    line_price_cents: opts.newPriceCents,
    before_snapshot: {
      qty: 1,
      line_price_cents: beforePriceCents,
      label: 'Shaker uppers + lowers',
    },
  });

  return { coId, approvalCode, cabinetsLineId };
}

test.describe
  .serial('customer CO approval round-trip', () => {
    test.skip(!canRun, 'requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    let seed: SeededDemo;

    test.beforeAll(async () => {
      seed = await seedDemo({ label: 'co-approval' });
    });

    test.afterAll(async () => {
      if (seed) await tearDownDemo(seed);
    });

    test('approve flow: types name → CO applied → cost line mutated', async ({ page, context }) => {
      const { coId, approvalCode, cabinetsLineId } = await seedPendingV2Co(seed, {
        newPriceCents: 1450000,
      });

      // Public route — no auth context.
      await context.clearCookies();
      await page.goto(`/approve/${approvalCode}`);

      // Sanity: the diff renders, cost impact is visible.
      await expect(page.getByText('Upgrade cabinet hardware')).toBeVisible();
      await expect(page.getByText(/cost impact/i)).toBeVisible();

      // Click Approve → name input → Confirm Approval.
      await page.getByRole('button', { name: /^approve$/i }).click();
      await page.getByPlaceholder('Your full name').fill('Jane Homeowner');
      await page.getByRole('button', { name: /confirm approval/i }).click();

      // UI confirms.
      await expect(page.getByText(/your contractor has been notified/i)).toBeVisible();

      // DB: CO is approved + applied. Poll briefly because the
      // server action returns before a small post-commit step
      // sometimes finishes flushing.
      await expect
        .poll(
          async () => {
            const { data } = await seed.admin
              .from('change_orders')
              .select('status, approved_by_name, approved_at, applied_at')
              .eq('id', coId)
              .single();
            return data;
          },
          { timeout: 10_000 },
        )
        .toMatchObject({
          status: 'approved',
          approved_by_name: 'Jane Homeowner',
        });

      const { data: applied } = await seed.admin
        .from('change_orders')
        .select('approved_at, applied_at')
        .eq('id', coId)
        .single();
      expect(applied?.approved_at).toBeTruthy();
      expect(applied?.applied_at).toBeTruthy();

      // Apply mutated the underlying cost line — this is the
      // critical regression check on applyV2ChangeOrderDiff.
      const { data: line } = await seed.admin
        .from('project_cost_lines')
        .select('line_price_cents, unit_price_cents')
        .eq('id', cabinetsLineId)
        .single();
      expect(line?.unit_price_cents).toBe(1450000);
      expect(line?.line_price_cents).toBe(1450000);
    });

    test('revisiting an approved CO short-circuits to "Already Approved"', async ({
      page,
      context,
    }) => {
      // Reuse the CO from the previous test — same describe, serial mode.
      const { data } = await seed.admin
        .from('change_orders')
        .select('approval_code')
        .eq('project_id', seed.projectId)
        .eq('status', 'approved')
        .single();
      const approvalCode = data?.approval_code as string;

      await context.clearCookies();
      await page.goto(`/approve/${approvalCode}`);
      await expect(page.getByRole('heading', { name: /already approved/i })).toBeVisible();
    });

    test('decline flow: CO becomes declined; lines NOT mutated', async ({ page, context }) => {
      const { coId, approvalCode, cabinetsLineId } = await seedPendingV2Co(seed, {
        // A second CO that would change the line further if approved.
        newPriceCents: 1600000,
      });

      // Snapshot the line BEFORE the decline. The previous test
      // already applied a CO to this line, so it's at $14,500 now.
      const { data: before } = await seed.admin
        .from('project_cost_lines')
        .select('line_price_cents')
        .eq('id', cabinetsLineId)
        .single();
      const lineBeforeCents = before?.line_price_cents as number;

      await context.clearCookies();
      await page.goto(`/approve/${approvalCode}`);

      await page.getByRole('button', { name: /^decline$/i }).click();
      await page.getByPlaceholder('Reason (optional)').fill('Out of budget');
      await page.getByRole('button', { name: /confirm decline/i }).click();
      await expect(page.getByText(/your contractor has been notified/i)).toBeVisible();

      // CO is declined; the diff was NOT applied.
      const { data: declined } = await seed.admin
        .from('change_orders')
        .select('status, declined_at, declined_reason, applied_at')
        .eq('id', coId)
        .single();
      expect(declined?.status).toBe('declined');
      expect(declined?.declined_reason).toBe('Out of budget');
      expect(declined?.applied_at).toBeNull();

      const { data: after } = await seed.admin
        .from('project_cost_lines')
        .select('line_price_cents')
        .eq('id', cabinetsLineId)
        .single();
      expect(after?.line_price_cents).toBe(lineBeforeCents);
    });
  });
