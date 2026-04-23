'use server';

/**
 * Server actions for Stripe Connect onboarding.
 *
 * Operators connect their own Standard Stripe account through the platform
 * (Smart Fusion Marketing Inc). The platform collects a 0.5% application fee
 * on each payment via `application_fee_amount` on PaymentIntents/Checkout.
 *
 * See PHASE_1_PLAN.md Phase 1C.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { guardMfaForSensitiveAction } from '@/lib/auth/mfa-enforcement';
import { getPaymentProvider } from '@/lib/providers/factory';
import { createClient } from '@/lib/supabase/server';

export type StripeActionResult = { ok: true; url?: string } | { ok: false; error: string };

/**
 * Create (or retrieve) a Stripe Connect Standard account for the current
 * tenant and return an Account Link URL for onboarding.
 */
export async function createConnectOnboardingAction(): Promise<StripeActionResult> {
  const block = await guardMfaForSensitiveAction();
  if (block) return block;

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  // Check if tenant already has a stripe_account_id saved.
  const { data: tenantRow, error: tenantErr } = await supabase
    .from('tenants')
    .select('stripe_account_id')
    .eq('id', tenant.id)
    .single();

  if (tenantErr) {
    return { ok: false, error: `Failed to load tenant: ${tenantErr.message}` };
  }

  let accountId = tenantRow?.stripe_account_id as string | null;

  const payments = await getPaymentProvider(tenant.id);

  // Create a new Connected account if we don't have one yet.
  if (!accountId) {
    const account = await payments.createMerchantAccount({ tenant_id: tenant.id });
    accountId = account.accountId;

    // Save the account ID to the tenant row immediately.
    const { error: saveErr } = await supabase
      .from('tenants')
      .update({ stripe_account_id: accountId, updated_at: new Date().toISOString() })
      .eq('id', tenant.id);

    if (saveErr) {
      return { ok: false, error: `Failed to save Stripe account: ${saveErr.message}` };
    }
  }

  // Build the onboarding URL.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const accountLink = await payments.createOnboardingLink(
    accountId,
    `${appUrl}/settings?stripe=refresh`,
    `${appUrl}/settings?stripe=success`,
  );

  return { ok: true, url: accountLink.url };
}

/**
 * Verify the connected account status after the operator returns from Stripe.
 * Updates `stripe_onboarded_at` if charges and payouts are both enabled.
 */
export async function checkStripeStatusAction(): Promise<StripeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();

  const { data: tenantRow, error: tenantErr } = await supabase
    .from('tenants')
    .select('stripe_account_id, stripe_onboarded_at')
    .eq('id', tenant.id)
    .single();

  if (tenantErr) {
    return { ok: false, error: `Failed to load tenant: ${tenantErr.message}` };
  }

  const accountId = tenantRow?.stripe_account_id as string | null;
  if (!accountId) {
    return { ok: false, error: 'No Stripe account connected.' };
  }

  const payments = await getPaymentProvider(tenant.id);
  const account = await payments.getMerchantAccount(accountId);

  if (account.chargesEnabled && account.payoutsEnabled) {
    const now = new Date().toISOString();
    const { error: updateErr } = await supabase
      .from('tenants')
      .update({
        stripe_onboarded_at: now,
        updated_at: now,
      })
      .eq('id', tenant.id);

    if (updateErr) {
      return { ok: false, error: `Failed to update onboarding status: ${updateErr.message}` };
    }
  }

  revalidatePath('/settings');
  return { ok: true };
}

/**
 * Disconnect the Stripe account from this tenant. Clears the stripe fields
 * but does NOT deauthorize the account on Stripe's side (Phase 2).
 */
export async function disconnectStripeAction(): Promise<StripeActionResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const now = new Date().toISOString();

  const { error } = await supabase
    .from('tenants')
    .update({
      stripe_account_id: null,
      stripe_onboarded_at: null,
      stripe_tos_accepted_at: null,
      stripe_tos_version: null,
      updated_at: now,
    })
    .eq('id', tenant.id);

  if (error) {
    return { ok: false, error: `Failed to disconnect: ${error.message}` };
  }

  revalidatePath('/settings');
  return { ok: true };
}
