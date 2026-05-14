'use server';

/**
 * In-app billing-management server actions powering /settings/billing:
 * overview, invoice history, card update via SetupIntent, plan change with
 * proration preview, and pause-for-30-days (cancel-prevention alternative).
 *
 * Cancel + checkout-start live in the sibling `billing.ts`. Webhook is the
 * source of truth for the local `tenants.plan` / `subscription_status`
 * mirror — these actions stage Stripe and wait for the webhook to flip
 * local state. The page revalidates on success so the next render sees it.
 */

import { revalidatePath } from 'next/cache';
import type Stripe from 'stripe';
import { requireTenant } from '@/lib/auth/helpers';
import type { Plan } from '@/lib/billing/features';
import {
  type BillingCycle,
  findPlanForPriceId,
  getPriceId,
  isBillingCycle,
  isPlan,
} from '@/lib/billing/plans';
import {
  getDefaultCard,
  getPlatformStripe,
  type LoadedSubscription,
  loadSubscriptionExpanded,
} from '@/lib/billing/stripe-subscription';
import { createAdminClient } from '@/lib/supabase/admin';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export type BillingOverview =
  | {
      ok: true;
      hasSubscription: false;
      hasCustomer: boolean;
    }
  | {
      ok: true;
      hasSubscription: true;
      hasCustomer: true;
      plan: Plan;
      cycle: BillingCycle;
      status: 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
      cancelAtPeriodEnd: boolean;
      pausedUntil: string | null; // ISO if pause_collection.resumes_at set
      currentPeriodEnd: string; // ISO
      trialEndsAt: string | null;
      promoCode: string | null;
      defaultCard: { brand: string; last4: string; expMonth: number; expYear: number } | null;
    };

export async function getBillingOverviewAction(): Promise<BillingOverview> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('id', tenant.id)
    .single();

  const customerId = (data?.stripe_customer_id as string | null) ?? null;
  const subId = (data?.stripe_subscription_id as string | null) ?? null;

  if (!subId || !customerId) {
    return { ok: true, hasSubscription: false, hasCustomer: Boolean(customerId) };
  }

  const sub = await loadSubscriptionExpanded(subId);
  const card = await getDefaultCard({ customerId, subscription: sub });
  const item = sub.items.data[0];
  const priceId = item?.price.id ?? null;
  const planMatch = priceId ? findPlanForPriceId(priceId) : null;

  // current_period_end moved to the subscription item in newer API versions.
  const periodEndSec =
    (item as unknown as { current_period_end?: number }).current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end;

  // Active discount → promo code (FOUNDER, etc).
  const discount = (sub as unknown as { discount?: Stripe.Discount | null }).discount ?? null;
  const promoCode =
    discount && typeof discount.promotion_code !== 'string' && discount.promotion_code
      ? discount.promotion_code.code
      : null;

  return {
    ok: true,
    hasSubscription: true,
    hasCustomer: true,
    plan: (planMatch?.plan ?? (tenant.plan as Plan)) as Plan,
    cycle: (planMatch?.cycle ?? 'monthly') as BillingCycle,
    status: mapStatus(sub.status),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
    pausedUntil: sub.pause_collection?.resumes_at
      ? new Date(sub.pause_collection.resumes_at * 1000).toISOString()
      : sub.pause_collection
        ? 'indefinite'
        : null,
    currentPeriodEnd: periodEndSec ? new Date(periodEndSec * 1000).toISOString() : '',
    trialEndsAt: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    promoCode,
    defaultCard: card,
  };
}

type SimpleStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'unpaid';
function mapStatus(s: Stripe.Subscription.Status): SimpleStatus {
  switch (s) {
    case 'trialing':
    case 'active':
    case 'past_due':
    case 'unpaid':
      return s;
    default:
      return 'canceled';
  }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export type InvoiceRow = {
  id: string;
  number: string | null;
  createdIso: string;
  amountDueCents: number;
  amountPaidCents: number;
  taxCents: number;
  currency: string;
  status: string;
  hostedUrl: string | null;
  pdfUrl: string | null;
};

export type InvoiceListResult =
  | { ok: true; invoices: InvoiceRow[]; hasMore: boolean; nextCursor: string | null }
  | { ok: false; error: string };

export async function listInvoicesAction(input: {
  cursor?: string | null;
  limit?: number;
}): Promise<InvoiceListResult> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_customer_id')
    .eq('id', tenant.id)
    .single();
  const customerId = (data?.stripe_customer_id as string | null) ?? null;
  if (!customerId) return { ok: true, invoices: [], hasMore: false, nextCursor: null };

  const stripe = await getPlatformStripe();
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 50);
  const params: Stripe.InvoiceListParams = { customer: customerId, limit };
  if (input.cursor) params.starting_after = input.cursor;

  const list = await stripe.invoices.list(params);
  const invoices: InvoiceRow[] = list.data.map((inv) => ({
    id: inv.id ?? '',
    number: inv.number,
    createdIso: new Date(inv.created * 1000).toISOString(),
    amountDueCents: inv.amount_due,
    amountPaidCents: inv.amount_paid,
    taxCents: extractTaxCents(inv),
    currency: (inv.currency ?? 'cad').toLowerCase(),
    status: inv.status ?? 'unknown',
    hostedUrl: inv.hosted_invoice_url ?? null,
    pdfUrl: inv.invoice_pdf ?? null,
  }));

  return {
    ok: true,
    invoices,
    hasMore: list.has_more,
    nextCursor: list.has_more ? (list.data[list.data.length - 1]?.id ?? null) : null,
  };
}

// ---------------------------------------------------------------------------
// Card update via SetupIntent
// ---------------------------------------------------------------------------

export type SetupIntentResult = { ok: true; clientSecret: string } | { ok: false; error: string };

export async function createSetupIntentAction(): Promise<SetupIntentResult> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_customer_id')
    .eq('id', tenant.id)
    .single();
  const customerId = (data?.stripe_customer_id as string | null) ?? null;
  if (!customerId) return { ok: false, error: 'No Stripe customer on file yet.' };

  const stripe = await getPlatformStripe();
  const intent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: { tenant_id: tenant.id, kind: 'card_update' },
  });
  if (!intent.client_secret) return { ok: false, error: 'Stripe returned no client secret.' };
  return { ok: true, clientSecret: intent.client_secret };
}

export type SetDefaultPmResult = { ok: true } | { ok: false; error: string };

/**
 * After Stripe.js confirms the SetupIntent client-side, the resulting
 * PaymentMethod is already attached to the customer. We just need to
 * promote it to default — both at the customer level (so future invoices
 * use it) and on the active subscription (so renewal uses it next cycle).
 */
export async function setDefaultPaymentMethodAction(input: {
  paymentMethodId: string;
}): Promise<SetDefaultPmResult> {
  const { tenant } = await requireTenant();
  if (!input.paymentMethodId.startsWith('pm_')) {
    return { ok: false, error: 'Invalid payment method id.' };
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  const customerId = (data?.stripe_customer_id as string | null) ?? null;
  const subId = (data?.stripe_subscription_id as string | null) ?? null;
  if (!customerId) return { ok: false, error: 'No Stripe customer on file yet.' };

  const stripe = await getPlatformStripe();
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: input.paymentMethodId },
  });
  if (subId) {
    await stripe.subscriptions.update(subId, { default_payment_method: input.paymentMethodId });
  }
  revalidatePath('/settings/billing');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Plan change
// ---------------------------------------------------------------------------

export type PlanChangePreview =
  | {
      ok: true;
      immediateChargeCents: number; // positive = charge now, negative = credit
      currency: string;
      nextRenewalDate: string;
      nextRenewalAmountCents: number;
      isUpgrade: boolean;
    }
  | { ok: false; error: string };

export async function previewPlanChangeAction(input: {
  plan: string;
  cycle: string;
}): Promise<PlanChangePreview> {
  if (!isPlan(input.plan)) return { ok: false, error: 'Invalid plan.' };
  if (!isBillingCycle(input.cycle)) return { ok: false, error: 'Invalid billing cycle.' };

  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_customer_id, stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  const customerId = (data?.stripe_customer_id as string | null) ?? null;
  const subId = (data?.stripe_subscription_id as string | null) ?? null;
  if (!customerId || !subId) return { ok: false, error: 'No active subscription.' };

  const stripe = await getPlatformStripe();
  const sub = await loadSubscriptionExpanded(subId);
  const newPriceId = getPriceId(input.plan, input.cycle);
  const item = sub.items.data[0];
  if (!item) return { ok: false, error: 'Subscription has no items.' };

  if (item.price.id === newPriceId) {
    return { ok: false, error: 'Already on this plan and cycle.' };
  }

  // `invoices.retrieveUpcoming` is the canonical proration preview API.
  // Some Stripe SDK versions surface it under a different name (`createPreview`);
  // we cast through `unknown` to stay version-agnostic.
  const upcoming = await retrieveUpcomingInvoice(stripe, {
    customer: customerId,
    subscription: subId,
    subscription_items: [{ id: item.id, price: newPriceId }],
    subscription_proration_behavior: 'create_prorations',
  });

  const isUpgrade = comparePlanRank(input.plan as Plan, planRankFromSubscription(sub)) > 0;

  return {
    ok: true,
    immediateChargeCents: upcoming.amount_due,
    currency: (upcoming.currency ?? 'cad').toLowerCase(),
    nextRenewalDate: new Date(
      (upcoming.next_payment_attempt ?? upcoming.created) * 1000,
    ).toISOString(),
    nextRenewalAmountCents: upcoming.total,
    isUpgrade,
  };
}

export type PlanChangeResult = { ok: true } | { ok: false; error: string };

export async function changePlanAction(input: {
  plan: string;
  cycle: string;
}): Promise<PlanChangeResult> {
  if (!isPlan(input.plan)) return { ok: false, error: 'Invalid plan.' };
  if (!isBillingCycle(input.cycle)) return { ok: false, error: 'Invalid billing cycle.' };

  const { tenant } = await requireTenant();
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only the account owner can change the plan.' };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  const subId = (data?.stripe_subscription_id as string | null) ?? null;
  if (!subId) return { ok: false, error: 'No active subscription.' };

  const stripe = await getPlatformStripe();
  const sub = await loadSubscriptionExpanded(subId);
  const item = sub.items.data[0];
  if (!item) return { ok: false, error: 'Subscription has no items.' };

  const newPriceId = getPriceId(input.plan, input.cycle);
  if (item.price.id === newPriceId) return { ok: false, error: 'Already on this plan and cycle.' };

  await stripe.subscriptions.update(subId, {
    items: [{ id: item.id, price: newPriceId }],
    proration_behavior: 'create_prorations',
    metadata: {
      ...(sub.metadata ?? {}),
      plan: input.plan,
      billing_cycle: input.cycle,
    },
  });

  revalidatePath('/settings/billing');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pause-for-30-days
// ---------------------------------------------------------------------------

export type PauseResult = { ok: true; resumesAtIso: string } | { ok: false; error: string };

const PAUSE_DAYS = 30;

export async function pauseSubscriptionAction(): Promise<PauseResult> {
  const { tenant } = await requireTenant();
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only the account owner can pause the subscription.' };
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  const subId = (data?.stripe_subscription_id as string | null) ?? null;
  if (!subId) return { ok: false, error: 'No active subscription to pause.' };

  const stripe = await getPlatformStripe();
  const resumesAtSec = Math.floor(Date.now() / 1000) + PAUSE_DAYS * 86_400;
  await stripe.subscriptions.update(subId, {
    pause_collection: { behavior: 'mark_uncollectible', resumes_at: resumesAtSec },
  });
  revalidatePath('/settings/billing');
  return { ok: true, resumesAtIso: new Date(resumesAtSec * 1000).toISOString() };
}

export async function resumeSubscriptionAction(): Promise<
  { ok: true } | { ok: false; error: string }
> {
  const { tenant } = await requireTenant();
  if (tenant.member.role !== 'owner' && tenant.member.role !== 'admin') {
    return { ok: false, error: 'Only the account owner can resume the subscription.' };
  }
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  const subId = (data?.stripe_subscription_id as string | null) ?? null;
  if (!subId) return { ok: false, error: 'No active subscription.' };

  const stripe = await getPlatformStripe();
  await stripe.subscriptions.update(subId, {
    pause_collection: null as unknown as Stripe.SubscriptionUpdateParams['pause_collection'],
  });
  revalidatePath('/settings/billing');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Tax field shape varies across Stripe API versions: pre-Aug-2025 invoices
 * had a top-level `tax` cents field, newer versions expose `total_taxes`
 * (an array of {amount}). Read both defensively so version bumps don't
 * break the table.
 */
function extractTaxCents(inv: Stripe.Invoice): number {
  const legacy = (inv as unknown as { tax?: number | null }).tax;
  if (typeof legacy === 'number') return legacy;
  const totalTaxes = (inv as unknown as { total_taxes?: Array<{ amount?: number }> }).total_taxes;
  if (Array.isArray(totalTaxes)) {
    return totalTaxes.reduce((sum, t) => sum + (t.amount ?? 0), 0);
  }
  return 0;
}

const PLAN_RANK: Record<Plan, number> = { starter: 0, growth: 1, pro: 2, scale: 3 };

function planRankFromSubscription(sub: LoadedSubscription): Plan {
  const priceId = sub.items.data[0]?.price.id;
  const match = priceId ? findPlanForPriceId(priceId) : null;
  return (match?.plan ?? 'starter') as Plan;
}

function comparePlanRank(a: Plan, b: Plan): number {
  return PLAN_RANK[a] - PLAN_RANK[b];
}

type UpcomingInvoiceArgs = {
  customer: string;
  subscription: string;
  subscription_items: Array<{ id: string; price: string }>;
  subscription_proration_behavior: 'create_prorations';
};

/**
 * `invoices.retrieveUpcoming` was renamed to `invoices.createPreview` in
 * Stripe API 2024-09-30+. We try the new name first and fall back to the
 * old one so this works across SDK upgrades.
 */
async function retrieveUpcomingInvoice(
  stripe: Stripe,
  args: UpcomingInvoiceArgs,
): Promise<Stripe.Invoice> {
  const inv = stripe.invoices as unknown as {
    createPreview?: (a: UpcomingInvoiceArgs) => Promise<Stripe.Invoice>;
    retrieveUpcoming?: (a: UpcomingInvoiceArgs) => Promise<Stripe.Invoice>;
  };
  if (typeof inv.createPreview === 'function') return inv.createPreview(args);
  if (typeof inv.retrieveUpcoming === 'function') return inv.retrieveUpcoming(args);
  throw new Error('Stripe SDK exposes neither createPreview nor retrieveUpcoming.');
}
