/**
 * Draws end-to-end against the seeded demo fixture.
 *
 * Covers what shipped this week: doc_type='draw' invoices created
 * from the project Customer Billing tab are tax-inclusive, carry an
 * operator-set % complete, and the customer-facing view shows
 * "Progress payment ... — N% complete" inline with the embedded GST.
 */

import { expect, test } from '@playwright/test';
import { type SeededDemo, seedDemo, signInAsOwner, tearDownDemo } from './_helpers/seed-demo';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('project draws', () => {
    test.skip(!canRun, 'requires NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY');

    let seed: SeededDemo;

    test.beforeAll(async () => {
      seed = await seedDemo({ label: 'draws' });
    });

    test.afterAll(async () => {
      if (seed) await tearDownDemo(seed);
    });

    test('operator creates draw with % complete; invoice row reflects it', async ({ page }) => {
      await signInAsOwner(page, seed);

      // Land on the project's Customer Billing tab.
      await page.goto(`/projects/${seed.projectId}?tab=invoices`);

      // The button label is "+ New draw" since the rename. Hidden if a
      // form is already open; the seeded project has no draws so it
      // renders by default.
      await page.getByRole('button', { name: /\+ new draw/i }).click();

      // Form: label defaults to "Draw #1", percent defaults to 0 (no
      // prior draws). Operator types a single line item totaling
      // $5,000 (tax-inclusive) and bumps the % to 25.
      await page.getByLabel(/% complete/i).fill('25');
      const lineRow = page.getByPlaceholder('Description').first();
      await lineRow.fill('Phase 1 deposit');
      await page.getByPlaceholder('Amount ($)').first().fill('5000');

      // The form's live total readout should call GST inclusive — a
      // regression check on the rename + tax-inclusive math.
      await expect(page.getByText(/incl\.\s+\$238\.10\s+gst/i)).toBeVisible();

      // Submit. Form action redirects to /invoices/<id>; landing there
      // confirms the action ran and the row was inserted. The redirect
      // appends ?from=...&fromLabel=... so the back-link on the invoice
      // page returns to Customer Billing — match the UUID without
      // anchoring on the end of the URL.
      await page.getByRole('button', { name: /^create draw$/i }).click();
      await page.waitForURL(/\/invoices\/[0-9a-f-]{36}(?:\?|$)/, { timeout: 20_000 });

      // Verify the DB row matches what we asked for.
      const { data: invoice } = await seed.admin
        .from('invoices')
        .select('amount_cents, tax_cents, doc_type, tax_inclusive, percent_complete, customer_note')
        .eq('project_id', seed.projectId)
        .single();
      expect(invoice).toBeTruthy();
      expect(invoice?.doc_type).toBe('draw');
      expect(invoice?.tax_inclusive).toBe(true);
      expect(invoice?.amount_cents).toBe(500000);
      // 5000 * 0.05 / 1.05 ≈ 238.10 → 23810 cents.
      expect(invoice?.tax_cents).toBe(23810);
      expect(invoice?.percent_complete).toBe(25);
      expect(invoice?.customer_note).toMatch(/draw\s*#1/i);
    });

    test('customer-facing view shows progress payment + % complete', async ({ page }) => {
      // Pull the freshly-created draw and mark it sent so the public
      // page renders (the page hides drafts).
      const { data: invoice } = await seed.admin
        .from('invoices')
        .select('id')
        .eq('project_id', seed.projectId)
        .eq('doc_type', 'draw')
        .single();
      expect(invoice).toBeTruthy();
      await seed.admin
        .from('invoices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invoice?.id as string);

      // Public page: no auth.
      await page.goto(`/view/invoice/${invoice?.id}`);

      // Progress-payment line includes the operator's % complete.
      await expect(page.getByText(/progress payment/i)).toBeVisible();
      await expect(page.getByText(/25% complete/i)).toBeVisible();

      // Total + embedded GST line. "GST (5%, included)" is the
      // canonical copy for tax-inclusive invoices.
      await expect(page.getByText(/included/i)).toBeVisible();
    });
  });
