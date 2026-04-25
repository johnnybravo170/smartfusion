'use server';

/**
 * Billing server actions: start a subscription Checkout session.
 *
 * Webhook (`/api/stripe/webhook`) is what actually flips the tenant's
 * plan + status — these actions just stage Stripe and redirect.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireTenant } from '@/lib/auth/helpers';
import { type BillingCycle, isBillingCycle, isPlan } from '@/lib/billing/plans';
import {
  createSubscriptionCheckoutSession,
  ensureStripeCustomer,
} from '@/lib/billing/stripe-subscription';
import { createAdminClient } from '@/lib/supabase/admin';

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

export async function startCheckoutAction(input: {
  plan: string;
  billing: string;
}): Promise<{ error: string } | never> {
  if (!isPlan(input.plan)) return { error: 'Invalid plan.' };
  if (!isBillingCycle(input.billing)) return { error: 'Invalid billing cycle.' };

  const { user, tenant } = await requireTenant();
  if (!user.email) return { error: 'Account is missing an email address.' };

  const admin = createAdminClient();
  const { data: row, error: rowErr } = await admin
    .from('tenants')
    .select('stripe_customer_id, name')
    .eq('id', tenant.id)
    .single();
  if (rowErr || !row) return { error: 'Could not load tenant.' };

  const customerId = await ensureStripeCustomer({
    existingCustomerId: (row.stripe_customer_id as string | null) ?? null,
    tenantId: tenant.id,
    email: user.email,
    name: (row.name as string) ?? tenant.name,
  });

  if (!row.stripe_customer_id) {
    await admin
      .from('tenants')
      .update({ stripe_customer_id: customerId, updated_at: new Date().toISOString() })
      .eq('id', tenant.id);
  }

  const origin = await originFromHeaders();
  const { url } = await createSubscriptionCheckoutSession({
    customerId,
    tenantId: tenant.id,
    plan: input.plan,
    cycle: input.billing as BillingCycle,
    successUrl: `${origin}/onboarding/plan/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/onboarding/plan?canceled=1`,
  });

  redirect(url);
}
