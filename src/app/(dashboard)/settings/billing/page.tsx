import { CreditCard, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { CancelSubscriptionButton } from '@/components/features/billing/cancel-subscription-button';
import { ManagePaymentMethodButton } from '@/components/features/billing/manage-payment-method-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireTenant } from '@/lib/auth/helpers';
import { PLAN_CATALOG } from '@/lib/billing/plans';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Billing settings — current plan, payment method, and self-serve cancel.
 *
 * Cancel policy is documented at /refund-policy. The button here is the
 * single entry point for self-serve cancellation; no friction, no upsell.
 */
export default async function BillingPage() {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select(
      'plan, subscription_status, current_period_end, trial_ends_at, stripe_subscription_id, stripe_customer_id',
    )
    .eq('id', tenant.id)
    .single();

  const plan = ((data?.plan as string | null) ?? tenant.plan) as keyof typeof PLAN_CATALOG;
  const status = (data?.subscription_status as string | null) ?? tenant.subscriptionStatus;
  const periodEnd = (data?.current_period_end as string | null) ?? null;
  const trialEnd = (data?.trial_ends_at as string | null) ?? null;
  const hasSubscription = Boolean(data?.stripe_subscription_id);
  const hasCustomer = Boolean(data?.stripe_customer_id);

  const planCopy = PLAN_CATALOG[plan] ?? PLAN_CATALOG.starter;
  const renewalDate = periodEnd ? formatDate(periodEnd) : null;
  const trialDate = trialEnd ? formatDate(trialEnd) : null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your plan, payment method, and subscription. See the{' '}
          <Link href="/refund-policy" className="underline underline-offset-2">
            refund policy
          </Link>{' '}
          for what happens when you cancel.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <Sparkles className="size-5 mt-0.5" />
              <div>
                <CardTitle>{planCopy.name} plan</CardTitle>
                <CardDescription>{planCopy.tagline}</CardDescription>
              </div>
            </div>
            <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground capitalize">
              {status.replace('_', ' ')}
            </span>
          </div>
        </CardHeader>
        <CardContent className="text-sm space-y-1 text-muted-foreground">
          {status === 'trialing' && trialDate ? <p>Trial ends {trialDate}.</p> : null}
          {status !== 'trialing' && renewalDate ? <p>Next renewal {renewalDate}.</p> : null}
          {status === 'canceled' ? (
            <p>
              Subscription cancelled. Access continues until{' '}
              {renewalDate ?? 'the end of the period'}.
            </p>
          ) : null}
          {!hasSubscription ? (
            <p>
              No active subscription.{' '}
              <Link href="/onboarding/plan" className="underline underline-offset-2">
                Pick a plan
              </Link>
              .
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CreditCard className="size-5" />
            <div>
              <CardTitle>Payment method</CardTitle>
              <CardDescription>Update your card or view past invoices.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ManagePaymentMethodButton disabled={!hasCustomer} />
        </CardContent>
      </Card>

      {hasSubscription ? (
        <Card>
          <CardHeader>
            <CardTitle>Cancel subscription</CardTitle>
            <CardDescription>
              Stops auto-renewal immediately and refunds the unused portion of the current billing
              period to your original card. You keep access through the end of the period you've
              already paid for.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CancelSubscriptionButton />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}
