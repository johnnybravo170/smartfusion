'use server';

/**
 * Billing server actions: start a subscription Checkout session, preview the
 * cancel-refund amount, and execute a self-serve cancel + prorated refund.
 *
 * Webhook (`/api/stripe/webhook`) is what actually flips the tenant's
 * plan + status — these actions just stage Stripe and redirect.
 *
 * Cancel policy (locked):
 *   - cancel_at_period_end=true (soft wind-down — access continues to period end)
 *   - refund the unused portion of the current paid period to the original
 *     card via stripe.refunds.create({ charge })
 *   - trial cancels delete immediately, no refund
 *   - never refund past periods, only the current one
 */

import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import type Stripe from 'stripe';
import { requireTenant } from '@/lib/auth/helpers';
import { type BillingCycle, isBillingCycle, isPlan } from '@/lib/billing/plans';
import {
  createSubscriptionCheckoutSession,
  ensureStripeCustomer,
  getPlatformStripe,
} from '@/lib/billing/stripe-subscription';
import { sendEmail } from '@/lib/email/send';
import { refundConfirmationEmailHtml } from '@/lib/email/templates/refund-confirmation';
import { createAdminClient } from '@/lib/supabase/admin';

async function originFromHeaders(): Promise<string> {
  const h = await headers();
  const origin = h.get('origin');
  if (origin) return origin;
  const host = h.get('host') ?? 'localhost:3000';
  const proto = h.get('x-forwarded-proto') ?? 'http';
  return `${proto}://${host}`;
}

export type PromoEffects = { promotionCodeId: string | null; skipTrial: boolean };

/**
 * Resolves a human-readable promo code (e.g. `FOUNDER`) to its Stripe
 * `promotion_code` id and any side-effects encoded in metadata.
 *
 * `skip_trial: 'true'` on the promo code's metadata bypasses the 14-day
 * trial — used for founder/handshake deals where the customer is already
 * committed and we want immediate billing. Set in the seed script.
 *
 * Returns null id if the code doesn't exist, isn't active, or otherwise
 * can't be applied — we don't surface the error; checkout falls through
 * to full-price with Stripe's built-in promo field.
 */
export async function resolvePromoEffects(code: string): Promise<PromoEffects> {
  try {
    const stripe = await getPlatformStripe();
    const list = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    const promo = list.data[0];
    if (!promo) return { promotionCodeId: null, skipTrial: false };
    return {
      promotionCodeId: promo.id,
      skipTrial: promo.metadata?.skip_trial === 'true',
    };
  } catch {
    return { promotionCodeId: null, skipTrial: false };
  }
}

export async function startCheckoutAction(input: {
  plan: string;
  billing: string;
  promo?: string | null;
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

  const promo = input.promo
    ? await resolvePromoEffects(input.promo)
    : { promotionCodeId: null, skipTrial: false };

  const origin = await originFromHeaders();
  const { url } = await createSubscriptionCheckoutSession({
    customerId,
    tenantId: tenant.id,
    plan: input.plan,
    cycle: input.billing as BillingCycle,
    successUrl: `${origin}/onboarding/plan/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/onboarding/plan?canceled=1`,
    promotionCode: promo.promotionCodeId,
    skipTrial: promo.skipTrial,
  });

  redirect(url);
}

// ---------------------------------------------------------------------------
// Self-serve cancel + prorated refund
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

export type CancelRefundPreview = {
  ok: true;
  isTrial: boolean;
  refundCents: number;
  periodAmountCents: number;
  unusedDays: number;
  totalDays: number;
  accessEndsAt: string; // ISO; for trial = now()
  currency: string; // lowercased Stripe code, e.g. 'cad'
  cardLast4: string | null;
};

export type CancelRefundError = { ok: false; error: string };

type SubscriptionWithCharge = Stripe.Subscription & {
  latest_invoice?: Stripe.Invoice | string | null;
};

type InvoiceWithCharge = Stripe.Invoice & {
  charge?: string | Stripe.Charge | null;
};

async function loadSubscriptionForCancel(
  stripeSubId: string,
): Promise<{ sub: SubscriptionWithCharge; invoice: InvoiceWithCharge | null }> {
  const stripe = await getPlatformStripe();
  const sub = (await stripe.subscriptions.retrieve(stripeSubId, {
    expand: ['latest_invoice', 'latest_invoice.payment_intent'],
  })) as SubscriptionWithCharge;

  let invoice: InvoiceWithCharge | null = null;
  if (sub.latest_invoice && typeof sub.latest_invoice !== 'string') {
    invoice = sub.latest_invoice as InvoiceWithCharge;
  }
  return { sub, invoice };
}

/**
 * Resolve the charge id for the latest invoice. The `charge` field on
 * Invoice was removed in newer Stripe API versions — fall back to the
 * payment_intent's latest_charge when needed.
 */
async function resolveChargeId(invoice: InvoiceWithCharge | null): Promise<string | null> {
  if (!invoice) return null;
  const direct = invoice.charge;
  if (typeof direct === 'string') return direct;
  if (direct && typeof direct === 'object' && 'id' in direct) return direct.id;

  const piRef = (invoice as unknown as { payment_intent?: string | Stripe.PaymentIntent | null })
    .payment_intent;
  if (!piRef) return null;
  const stripe = await getPlatformStripe();
  const pi = typeof piRef === 'string' ? await stripe.paymentIntents.retrieve(piRef) : piRef;
  const latestCharge = pi.latest_charge;
  if (typeof latestCharge === 'string') return latestCharge;
  if (latestCharge && typeof latestCharge === 'object' && 'id' in latestCharge)
    return latestCharge.id;
  return null;
}

function periodBoundsFromSubscription(sub: SubscriptionWithCharge): {
  periodStartMs: number;
  periodEndMs: number;
} | null {
  const item = sub.items.data[0];
  // current_period_* live on the subscription item in newer API versions.
  const startSec =
    (item as unknown as { current_period_start?: number }).current_period_start ??
    (sub as unknown as { current_period_start?: number }).current_period_start;
  const endSec =
    (item as unknown as { current_period_end?: number }).current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;
  if (!startSec || !endSec) return null;
  return { periodStartMs: startSec * 1000, periodEndMs: endSec * 1000 };
}

/**
 * Pure preview — runs the same math as cancel without mutating Stripe.
 * Used by the confirm dialog so the user sees the exact refund amount and
 * access end date BEFORE the destructive button is clicked.
 */
export async function previewCancelRefund(): Promise<CancelRefundPreview | CancelRefundError> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data: row } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();

  const stripeSubId = (row?.stripe_subscription_id as string | null) ?? null;
  if (!stripeSubId) return { ok: false, error: 'No active subscription to cancel.' };

  const { sub, invoice } = await loadSubscriptionForCancel(stripeSubId);

  // Trial cancel — no refund, access ends immediately.
  if (sub.status === 'trialing') {
    return {
      ok: true,
      isTrial: true,
      refundCents: 0,
      periodAmountCents: 0,
      unusedDays: 0,
      totalDays: 0,
      accessEndsAt: new Date().toISOString(),
      currency: (sub.currency ?? 'cad').toLowerCase(),
      cardLast4: null,
    };
  }

  const bounds = periodBoundsFromSubscription(sub);
  if (!bounds) return { ok: false, error: 'Could not determine billing period.' };
  const { periodStartMs, periodEndMs } = bounds;

  const totalDays = Math.max(1, Math.ceil((periodEndMs - periodStartMs) / MS_PER_DAY));
  const usedDays = Math.max(0, Math.ceil((Date.now() - periodStartMs) / MS_PER_DAY));
  const unusedDays = Math.max(0, totalDays - usedDays);

  const periodAmountCents = invoice?.amount_paid ?? 0;
  const refundCents =
    periodAmountCents > 0 ? Math.round((unusedDays / totalDays) * periodAmountCents) : 0;

  const cardLast4 = extractCardLast4(invoice);

  return {
    ok: true,
    isTrial: false,
    refundCents,
    periodAmountCents,
    unusedDays,
    totalDays,
    accessEndsAt: new Date(periodEndMs).toISOString(),
    currency: (sub.currency ?? invoice?.currency ?? 'cad').toLowerCase(),
    cardLast4,
  };
}

function extractCardLast4(invoice: InvoiceWithCharge | null): string | null {
  if (!invoice) return null;
  const charge = invoice.charge;
  if (charge && typeof charge === 'object') {
    const details = (charge as Stripe.Charge).payment_method_details;
    if (details?.card?.last4) return details.card.last4;
  }
  return null;
}

export type CancelResult =
  | {
      ok: true;
      isTrial: boolean;
      refundCents: number;
      accessEndsAt: string;
      currency: string;
    }
  | CancelRefundError;

/**
 * Execute the cancel: set cancel_at_period_end (or delete immediately for
 * trial), issue the prorated refund, log it, send the confirmation email.
 *
 * Webhook is the source of truth for `subscription_status` — we let it
 * mirror the status flip rather than writing it from here.
 */
export async function cancelSubscriptionAction(): Promise<CancelResult> {
  const { user, tenant } = await requireTenant();
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only the account owner can cancel the subscription.' };
  }
  const admin = createAdminClient();

  const { data: row } = await admin
    .from('tenants')
    .select('stripe_subscription_id, contact_email, name')
    .eq('id', tenant.id)
    .single();

  const stripeSubId = (row?.stripe_subscription_id as string | null) ?? null;
  if (!stripeSubId) return { ok: false, error: 'No active subscription to cancel.' };

  const stripe = await getPlatformStripe();
  const { sub, invoice } = await loadSubscriptionForCancel(stripeSubId);
  const currency = (sub.currency ?? invoice?.currency ?? 'cad').toLowerCase();
  const recipientEmail = (row?.contact_email as string | null) ?? user.email ?? null;
  const firstName = inferFirstName(user.email, (row?.name as string | null) ?? tenant.name);

  // ---- Trial cancel: delete now, no refund ----
  if (sub.status === 'trialing') {
    await stripe.subscriptions.cancel(stripeSubId);

    await admin.from('refunds_log').insert({
      tenant_id: tenant.id,
      user_id: user.id,
      stripe_subscription_id: stripeSubId,
      amount_cents: 0,
      currency,
      reason: 'user_cancel',
      notes: 'trial cancellation',
      refunded_by: user.id,
    });

    if (recipientEmail) {
      await sendEmail({
        to: recipientEmail,
        subject: 'Your HeyHenry trial has been cancelled',
        html: refundConfirmationEmailHtml({
          firstName,
          refundAmountFormatted: '$0.00',
          cardLast4: null,
          accessEndsAtFormatted: 'today',
          isTrial: true,
        }),
        tenantId: tenant.id,
        caslCategory: 'transactional',
        relatedType: 'billing',
        relatedId: stripeSubId,
        caslEvidence: { kind: 'trial_cancellation', subscriptionId: stripeSubId },
      });
    }

    revalidatePath('/settings/billing');
    return {
      ok: true,
      isTrial: true,
      refundCents: 0,
      accessEndsAt: new Date().toISOString(),
      currency,
    };
  }

  // ---- Paid cancel: cancel at period end, refund unused portion ----
  const bounds = periodBoundsFromSubscription(sub);
  if (!bounds) return { ok: false, error: 'Could not determine billing period.' };
  const { periodStartMs, periodEndMs } = bounds;

  const totalDays = Math.max(1, Math.ceil((periodEndMs - periodStartMs) / MS_PER_DAY));
  const usedDays = Math.max(0, Math.ceil((Date.now() - periodStartMs) / MS_PER_DAY));
  const unusedDays = Math.max(0, totalDays - usedDays);
  const periodAmountCents = invoice?.amount_paid ?? 0;
  const refundCents =
    periodAmountCents > 0 ? Math.round((unusedDays / totalDays) * periodAmountCents) : 0;

  // Soft wind-down: keep access until period end.
  await stripe.subscriptions.update(stripeSubId, { cancel_at_period_end: true });

  let stripeRefundId: string | null = null;
  let chargeId: string | null = null;
  if (refundCents > 0) {
    chargeId = await resolveChargeId(invoice);
    if (chargeId) {
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: refundCents,
        reason: 'requested_by_customer',
        metadata: { tenant_id: tenant.id, kind: 'cancel_proration' },
      });
      stripeRefundId = refund.id;
    }
    // If no charge can be resolved (e.g. paid by something other than a
    // card-charge invoice), we still cancel auto-renewal but skip the
    // refund and log amount=0 with a note. Jonathan can issue manually.
  }

  await admin.from('refunds_log').insert({
    tenant_id: tenant.id,
    user_id: user.id,
    stripe_subscription_id: stripeSubId,
    stripe_charge_id: chargeId,
    stripe_refund_id: stripeRefundId,
    amount_cents: stripeRefundId ? refundCents : 0,
    currency,
    reason: 'user_cancel',
    notes: stripeRefundId
      ? `prorated ${unusedDays}/${totalDays} days of ${formatCents(periodAmountCents, currency)}`
      : refundCents > 0
        ? 'no chargeable invoice found; cancelled auto-renewal only — review for manual refund'
        : 'no charge to refund (zero-amount period)',
    refunded_by: user.id,
  });

  if (recipientEmail) {
    await sendEmail({
      to: recipientEmail,
      subject: 'Your HeyHenry refund is on its way',
      html: refundConfirmationEmailHtml({
        firstName,
        refundAmountFormatted: formatCents(stripeRefundId ? refundCents : 0, currency),
        cardLast4: extractCardLast4(invoice),
        accessEndsAtFormatted: formatAccessEnd(periodEndMs),
        isTrial: false,
      }),
      tenantId: tenant.id,
      caslCategory: 'transactional',
      relatedType: 'billing',
      relatedId: stripeSubId,
      caslEvidence: {
        kind: 'paid_cancellation',
        subscriptionId: stripeSubId,
        refundId: stripeRefundId,
      },
    });
  }

  revalidatePath('/settings/billing');
  return {
    ok: true,
    isTrial: false,
    refundCents: stripeRefundId ? refundCents : 0,
    accessEndsAt: new Date(periodEndMs).toISOString(),
    currency,
  };
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatAccessEnd(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function inferFirstName(email: string | null | undefined, fallback: string): string {
  if (email) {
    const local = email.split('@')[0];
    if (local) return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Stripe Customer Portal — manage payment method
// ---------------------------------------------------------------------------

export type PortalSessionResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * Returns a one-shot Customer Portal URL the client can window.location.assign
 * to. Lets the user update card / view invoices without us building the UI.
 */
export async function createBillingPortalSessionAction(): Promise<PortalSessionResult> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data: row } = await admin
    .from('tenants')
    .select('stripe_customer_id')
    .eq('id', tenant.id)
    .single();

  const customerId = (row?.stripe_customer_id as string | null) ?? null;
  if (!customerId) return { ok: false, error: 'No Stripe customer on file yet.' };

  const stripe = await getPlatformStripe();
  const origin = await originFromHeaders();
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${origin}/settings/billing`,
  });
  return { ok: true, url: session.url };
}
