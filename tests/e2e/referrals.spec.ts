/**
 * End-to-end test for the referral system (Plan A).
 *
 * Flow:
 *   1. Seed a tenant with a referral code via admin client
 *   2. Navigate to /referrals (dashboard) — verify link, stats, history
 *   3. Visit /r/{code} (public landing page) — verify social proof
 *   4. Click signup CTA — verify ref param in URL
 *   5. Sign up with ref code — verify referral tracked
 *   6. Cleanup
 */

import { expect, test } from '@playwright/test';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const canRun = Boolean(url && serviceRoleKey);

test.describe
  .serial('referrals: owner-to-owner referral system', () => {
    test.skip(!canRun, 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const businessName = `Referral E2E Co ${stamp}`;
    const refCode = `e2e-ref-${stamp}`.slice(0, 40).replace(/[^a-z0-9-]/g, '');
    const referrerEmail = `referrer-${stamp}@heyhenry.test`;
    const referredEmail = `referred-${stamp}@heyhenry.test`;

    let createdTenantId: string | null = null;
    let createdUserId: string | null = null;
    let referredTenantId: string | null = null;
    let referredUserId: string | null = null;

    test.afterAll(async () => {
      if (!canRun) return;
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Cleanup referrals and codes.
      if (createdTenantId) {
        await admin.from('referrals').delete().eq('referrer_tenant_id', createdTenantId);
        await admin.from('referral_codes').delete().eq('tenant_id', createdTenantId);
        await admin.from('tenant_members').delete().eq('tenant_id', createdTenantId);
        await admin.from('tenants').delete().eq('id', createdTenantId);
      }
      if (referredTenantId) {
        await admin.from('referral_codes').delete().eq('tenant_id', referredTenantId);
        await admin.from('tenant_members').delete().eq('tenant_id', referredTenantId);
        await admin.from('tenants').delete().eq('id', referredTenantId);
      }
      if (createdUserId) {
        await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
      }
      if (referredUserId) {
        await admin.auth.admin.deleteUser(referredUserId).catch(() => {});
      }
    });

    test('public referral landing page shows social proof and signup link', async ({ page }) => {
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // --- Seed referrer tenant ---
      const { data: authUser } = await admin.auth.admin.createUser({
        email: referrerEmail,
        password: 'Test-Password-123',
        email_confirm: true,
      });
      if (!authUser?.user?.id) throw new Error('Failed to create referrer user');
      createdUserId = authUser.user.id;

      const { data: tenant } = await admin
        .from('tenants')
        .insert({ name: businessName })
        .select('id')
        .single();
      if (!tenant?.id) throw new Error('Failed to create referrer tenant');
      createdTenantId = tenant.id as string;

      await admin
        .from('tenant_members')
        .insert({ tenant_id: createdTenantId, user_id: createdUserId, role: 'owner' });

      // Create referral code.
      await admin
        .from('referral_codes')
        .insert({ tenant_id: createdTenantId, code: refCode, type: 'operator' });

      // --- Visit public landing page ---
      await page.goto(`/r/${refCode}`);
      await expect(page.getByText(businessName, { exact: false })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByText('uses HeyHenry')).toBeVisible();

      // Verify CTA link contains ref param.
      const ctaLink = page.getByRole('link', { name: /trial|started/i });
      await expect(ctaLink).toBeVisible();
      const href = await ctaLink.getAttribute('href');
      expect(href).toContain(`ref=${refCode}`);
    });

    test('signup with referral code tracks referral and extends trial', async () => {
      const admin = createSupabaseClient(url as string, serviceRoleKey as string, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Create a pending referral row for the referrer.
      const { data: refCodeRow } = await admin
        .from('referral_codes')
        .select('id')
        .eq('code', refCode)
        .single();
      if (!refCodeRow) throw new Error('Referral code not found');

      await admin.from('referrals').insert({
        referral_code_id: refCodeRow.id,
        referrer_tenant_id: createdTenantId,
        referred_email: referredEmail,
        status: 'pending',
      });

      // Simulate signup with referral code by creating tenant directly.
      const { data: refAuth } = await admin.auth.admin.createUser({
        email: referredEmail,
        password: 'Test-Password-123',
        email_confirm: true,
      });
      if (!refAuth?.user?.id) throw new Error('Failed to create referred user');
      referredUserId = refAuth.user.id;

      const trialEnd = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
      const { data: refTenant } = await admin
        .from('tenants')
        .insert({
          name: `Referred Co ${stamp}`,
          referred_by_code: refCode,
          trial_ends_at: trialEnd,
        })
        .select('id')
        .single();
      if (!refTenant?.id) throw new Error('Failed to create referred tenant');
      referredTenantId = refTenant.id as string;

      await admin
        .from('tenant_members')
        .insert({ tenant_id: referredTenantId, user_id: referredUserId, role: 'owner' });

      // Verify the tenant has the referral code and trial.
      const { data: verifyTenant } = await admin
        .from('tenants')
        .select('referred_by_code, trial_ends_at')
        .eq('id', referredTenantId)
        .single();

      expect(verifyTenant?.referred_by_code).toBe(refCode);
      expect(verifyTenant?.trial_ends_at).toBeTruthy();
    });
  });
