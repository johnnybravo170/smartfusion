/**
 * Stripe webhook handler.
 *
 * Single endpoint receives BOTH Connect events (invoice payments to
 * tenant merchant accounts) and platform-level events (HeyHenry's own
 * subscription billing). Connect events arrive with `event.account` set;
 * platform events do not.
 *
 * Handles:
 *   Connect:
 *     - checkout.session.completed (mode=payment, invoice metadata): mark invoice paid
 *     - account.updated: updates tenant Connect onboarding status
 *   Platform subscription:
 *     - checkout.session.completed (mode=subscription): record subscription + plan
 *     - customer.subscription.updated/deleted: keep status + plan in sync
 *     - invoice.payment_failed/payment_succeeded: nudge subscription_status
 */

import type Stripe from 'stripe';
import { findPlanForPriceId } from '@/lib/billing/plans';
import { getPlatformStripe, mapSubscriptionStatus } from '@/lib/billing/stripe-subscription';
import { getPaymentProviderForRegion } from '@/lib/providers/factory';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

const DEFAULT_REGION = 'ca-central-1';

export async function POST(request: Request) {
  const body = await request.text();
  const sig = request.headers.get('stripe-signature');

  if (!sig) {
    return new Response('Missing stripe-signature header', { status: 400 });
  }

  const payments = getPaymentProviderForRegion(DEFAULT_REGION);

  let event: Stripe.Event;
  try {
    const verified = await payments.verifyWebhook(body, sig);
    event = verified.raw as Stripe.Event;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(`Webhook signature verification failed: ${message}`, { status: 400 });
  }

  const supabase = await createClient();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;

      // Subscription Checkout (platform-level, mode=subscription) lands here
      // alongside Connect invoice payments. Branch on session.mode.
      if (session.mode === 'subscription') {
        await handleSubscriptionCheckoutCompleted(session);
        break;
      }

      const invoiceId = session.metadata?.invoice_id;

      if (invoiceId) {
        const paymentIntentId =
          typeof session.payment_intent === 'string'
            ? session.payment_intent
            : (session.payment_intent?.id ?? null);

        // Atomic: status flip + worklog insert in one Postgres transaction.
        // Idempotent — re-runs on an already-paid invoice are a no-op.
        const admin = createAdminClient();
        const { error: payErr } = await admin.rpc('mark_invoice_paid', {
          p_invoice_id: invoiceId,
          p_payment_intent_id: paymentIntentId,
          p_source: 'stripe_checkout',
        });
        if (payErr) {
          console.error('[stripe-webhook] mark_invoice_paid failed:', payErr.message);
        }
      }
      break;
    }

    case 'account.updated': {
      const account = event.data.object;
      if (account.charges_enabled && account.payouts_enabled) {
        const now = new Date().toISOString();
        // Find the tenant with this stripe_account_id and mark as onboarded.
        await supabase
          .from('tenants')
          .update({ stripe_onboarded_at: now, updated_at: now })
          .eq('stripe_account_id', account.id);
      }
      break;
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      // .deleted fires at period end after a self-serve cancel
      // (cancel_at_period_end=true). We mirror status=canceled and clear
      // the subscription id so a fresh signup later doesn't collide.
      await handleSubscriptionStateChange(event.data.object, event.type);
      break;
    }

    case 'invoice.payment_failed':
    case 'invoice.payment_succeeded': {
      // The subscription event covers the status flip too; this is just
      // a defensive sync in case ordering is unexpected.
      const invoice = event.data.object;
      const subRef = invoice.parent?.subscription_details?.subscription ?? null;
      const subId = typeof subRef === 'string' ? subRef : (subRef?.id ?? null);
      if (subId) {
        await syncSubscriptionFromId(subId);
      }
      break;
    }

    default:
      // Unhandled event type -- ignore.
      break;
  }

  return new Response('ok', { status: 200 });
}

async function handleSubscriptionCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const tenantId = session.metadata?.tenant_id;
  if (!tenantId) return;
  const subId =
    typeof session.subscription === 'string'
      ? session.subscription
      : (session.subscription?.id ?? null);
  if (!subId) return;
  await syncSubscriptionFromId(subId, tenantId);
}

async function handleSubscriptionStateChange(
  subscription: Stripe.Subscription,
  eventType?: string,
): Promise<void> {
  const tenantId = subscription.metadata?.tenant_id ?? null;
  await applySubscriptionToTenant(subscription, tenantId, {
    clearSubscriptionId: eventType === 'customer.subscription.deleted',
  });
}

async function syncSubscriptionFromId(
  subscriptionId: string,
  tenantIdHint?: string,
): Promise<void> {
  const stripe = await getPlatformStripe();
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const tenantId = tenantIdHint ?? subscription.metadata?.tenant_id ?? null;
  await applySubscriptionToTenant(subscription, tenantId);
}

async function applySubscriptionToTenant(
  subscription: Stripe.Subscription,
  tenantIdHint: string | null,
  opts: { clearSubscriptionId?: boolean } = {},
): Promise<void> {
  const admin = createAdminClient();

  // Resolve tenant: prefer metadata, fall back to stripe_customer_id lookup.
  let tenantId = tenantIdHint;
  if (!tenantId) {
    const customerId =
      typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
    const { data } = await admin
      .from('tenants')
      .select('id')
      .eq('stripe_customer_id', customerId)
      .maybeSingle();
    tenantId = (data?.id as string | null) ?? null;
  }
  if (!tenantId) return;

  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price.id;
  const planMatch = priceId ? findPlanForPriceId(priceId) : null;
  const status = mapSubscriptionStatus(subscription.status);
  // current_period_end moved from Subscription to SubscriptionItem in
  // recent Stripe API versions. Read from the first item.
  const currentPeriodEnd = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : null;
  const trialEnd = subscription.trial_end
    ? new Date(subscription.trial_end * 1000).toISOString()
    : null;

  const update: Record<string, unknown> = {
    stripe_subscription_id: opts.clearSubscriptionId ? null : subscription.id,
    subscription_status: status,
    current_period_end: currentPeriodEnd,
    trial_ends_at: trialEnd,
    updated_at: new Date().toISOString(),
  };
  if (planMatch) update.plan = planMatch.plan;

  await admin.from('tenants').update(update).eq('id', tenantId);
}
