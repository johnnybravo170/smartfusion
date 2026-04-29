/**
 * Audit lens end-to-end against the seeded fixture.
 *
 * Once a v2 CO is applied, its line/category/budget edits get folded
 * into the underlying project_cost_lines + project_budget_categories.
 * Without an audit trail, the operator can't tell what came from
 * which CO. This spec verifies the audit lens we shipped:
 *
 *   - Estimate tab shows "CO XXXXXXXX" chips next to lines that an
 *     applied CO modified, plus a "Change Order history" panel
 *     listing the applied COs with running impact total.
 *   - Budget tab shows the same chip on category rows the CO touched.
 *   - Overview "Revenue" composition card shows each applied CO as
 *     its own row, separate from the original line items.
 */

import { expect, test } from '@playwright/test';
import { type SeededDemo, seedDemo, signInAsOwner, tearDownDemo } from './_helpers/seed-demo';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('audit lens for applied COs', () => {
    test.skip(!canRun, 'requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    let seed: SeededDemo;
    let coId: string;
    let coShortId: string;
    const co_title = 'Upgrade cabinet hardware';

    test.beforeAll(async () => {
      seed = await seedDemo({ label: 'audit-lens' });

      // Layer an applied v2 CO onto the seeded project: the Cabinets
      // line goes from $13,000 to $14,500 (+$1,500). Mirrors what the
      // production apply-on-approval action does — write the CO row,
      // write a change_order_lines 'modify' entry, mutate the
      // underlying cost_line, set applied_at + status=approved.
      const { data: tenantRow } = await seed.admin
        .from('tenant_members')
        .select('user_id')
        .eq('tenant_id', seed.tenantId)
        .eq('role', 'owner')
        .single();
      const ownerUserId = tenantRow?.user_id as string;

      const { data: co } = await seed.admin
        .from('change_orders')
        .insert({
          tenant_id: seed.tenantId,
          project_id: seed.projectId,
          title: co_title,
          description: 'Customer requested soft-close hinges + handles.',
          cost_impact_cents: 150000,
          timeline_impact_days: 0,
          status: 'approved',
          flow_version: 2,
          applied_at: new Date().toISOString(),
          approved_at: new Date().toISOString(),
          approved_by_name: 'Jane Homeowner',
          created_by: ownerUserId,
        })
        .select('id')
        .single();
      coId = co?.id as string;
      coShortId = coId.slice(0, 8);

      const cabinetsLineId = seed.costLineIds[0];
      const cabinetsCatId = seed.budgetCategoryIdsByName.Cabinets;

      await seed.admin.from('change_order_lines').insert({
        change_order_id: coId,
        action: 'modify',
        original_line_id: cabinetsLineId,
        budget_category_id: cabinetsCatId,
        category: 'material',
        label: 'Shaker uppers + lowers',
        qty: 1,
        unit: 'set',
        unit_cost_cents: 900000,
        unit_price_cents: 1450000,
        line_cost_cents: 900000,
        line_price_cents: 1450000,
        before_snapshot: { qty: 1, line_price_cents: 1300000, label: 'Shaker uppers + lowers' },
      });

      // Mutate the cost_line to the post-apply state — what the live
      // apply action would have done.
      await seed.admin
        .from('project_cost_lines')
        .update({ unit_price_cents: 1450000, line_price_cents: 1450000 })
        .eq('id', cabinetsLineId);
    });

    test.afterAll(async () => {
      if (seed) await tearDownDemo(seed);
    });

    test('Estimate tab shows CO chip on the modified line + history panel', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto(`/projects/${seed.projectId}?tab=estimate`);

      // Chip on the affected line. There can be more than one chip on
      // the page (history panel also has one); first() is the line.
      const chip = page.getByText(`CO ${coShortId}`, { exact: false }).first();
      await expect(chip).toBeVisible();

      // History panel: heading + applied CO row with the title +
      // running impact total.
      await expect(page.getByText(/change order history/i)).toBeVisible();
      await expect(page.getByText(co_title)).toBeVisible();
      await expect(page.getByText(/\+\$1,500\.00/).first()).toBeVisible();
    });

    test('Budget tab shows CO chip linking to the applied CO', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto(`/projects/${seed.projectId}?tab=budget`);

      // The chip is an <a> linking to /projects/.../change-orders/<co.id>.
      // Targeting by href is unambiguous — there's only one chip on the
      // Budget tab in this scenario (one CO touching one category).
      const chip = page.locator(`a[href="/projects/${seed.projectId}/change-orders/${coId}"]`);
      await expect(chip).toBeVisible();
      await expect(chip).toHaveText(new RegExp(`CO ${coShortId}`, 'i'));
    });

    test('Overview Revenue card lists the applied CO as its own row', async ({ page }) => {
      await signInAsOwner(page, seed);
      await page.goto(`/projects/${seed.projectId}?tab=overview`);

      // The composition card has an "Applied CO: <title>" entry with
      // the cost impact, alongside Original line items + Management fee.
      await expect(page.getByText(`Applied CO: ${co_title}`)).toBeVisible();
      await expect(page.getByText(/original line items/i)).toBeVisible();
      await expect(page.getByText(/management fee/i)).toBeVisible();
    });
  });
