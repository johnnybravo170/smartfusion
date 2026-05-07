/**
 * Platform-level Stripe subscription helpers.
 *
 * Distinct from `StripeConnectPaymentProvider` (which handles invoice
 * payments to tenants' Connect accounts). These helpers run on the
 * PLATFORM Stripe account and create the subscription that bills the
 * contractor for HeyHenry itself.
 *
 * Trial: 14 days, card-required (`payment_method_collection: 'always'`).
 */

import Stripe from 'stripe';
import { getProviderSecret } from '@/lib/providers/secrets';
import type { Plan } from './features';
import type { BillingCycle } from './plans';
import { getPriceId } from './plans';

const API_VERSION = '2026-03-25.dahlia' as const;
const REGION = 'ca-central-1';

let cached: Stripe | null = null;

export async function getPlatformStripe(): Promise<Stripe> {
  if (!cached) {
    const key = await getProviderSecret(REGION, 'stripe', 'secret_key');
    cached = new Stripe(key, { apiVersion: API_VERSION });
  }
  return cached;
}

const getStripe = getPlatformStripe;

/**
 * Creates a Stripe customer for the tenant. Idempotent on caller —
 * pass the existing `stripeCustomerId` and we'll skip the create.
 */
export async function ensureStripeCustomer(input: {
  existingCustomerId: string | null;
  tenantId: string;
  email: string;
  name: string;
}): Promise<string> {
  if (input.existingCustomerId) return input.existingCustomerId;
  const stripe = await getStripe();
  const customer = await stripe.customers.create({
    email: input.email,
    name: input.name,
    metadata: { tenant_id: input.tenantId },
  });
  return customer.id;
}

/**
 * Creates a Stripe Checkout Session for a subscription. Returns the
 * hosted URL the user is redirected to.
 *
 * If `promotionCode` is supplied we pre-apply it as a discount on the
 * session. Otherwise we let Stripe show its built-in promo-code field
 * (`allow_promotion_codes`) so the user can type a code at checkout.
 * The two are mutually exclusive in Stripe — pre-applying disables the
 * input field.
 */
export async function createSubscriptionCheckoutSession(input: {
  customerId: string;
  tenantId: string;
  plan: Plan;
  cycle: BillingCycle;
  successUrl: string;
  cancelUrl: string;
  promotionCode?: string | null;
  skipTrial?: boolean;
}): Promise<{ url: string; sessionId: string }> {
  const stripe = await getStripe();
  const priceId = getPriceId(input.plan, input.cycle);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    customer: input.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: 'always',
    // Stripe Tax: computes GST/HST/PST/QST per the customer's billing
    // address. Requires the registration to be active in the Stripe
    // dashboard (Tax → Registrations).
    automatic_tax: { enabled: true },
    // Persist the address Stripe collects at checkout back onto the
    // Customer so renewals can compute tax without re-prompting.
    customer_update: { address: 'auto', name: 'auto' },
    // Lets B2B customers enter their own GST/HST number — it appears on
    // their invoice so they can claim input tax credits.
    tax_id_collection: { enabled: true },
    subscription_data: {
      ...(input.skipTrial ? {} : { trial_period_days: 14 }),
      metadata: { tenant_id: input.tenantId, plan: input.plan, billing_cycle: input.cycle },
    },
    metadata: { tenant_id: input.tenantId, plan: input.plan, billing_cycle: input.cycle },
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };

  if (input.promotionCode) {
    params.discounts = [{ promotion_code: input.promotionCode }];
  } else {
    params.allow_promotion_codes = true;
  }

  const session = await stripe.checkout.sessions.create(params);

  if (!session.url) throw new Error('Stripe Checkout returned no URL');
  return { url: session.url, sessionId: session.id };
}

/**
 * Maps Stripe's subscription status strings onto our DB enum.
 * Anything we don't explicitly handle collapses to 'canceled'
 * (treated as starter at the gate).
 */
export function mapSubscriptionStatus(
  status: Stripe.Subscription.Status,
): 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid' {
  switch (status) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'unpaid':
      return status;
    case 'canceled':
    case 'incomplete':
    case 'incomplete_expired':
    case 'paused':
      return 'canceled';
    default:
      return 'canceled';
  }
}
