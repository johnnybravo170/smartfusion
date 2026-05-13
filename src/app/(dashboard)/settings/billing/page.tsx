import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { CancelSubscriptionButton } from '@/components/features/billing/cancel-subscription-button';
import { ChangePlanCard } from '@/components/features/billing/change-plan-card';
import { InvoicesTable } from '@/components/features/billing/invoices-table';
import { PaymentMethodCard } from '@/components/features/billing/payment-method-card';
import { ResumeSubscriptionButton } from '@/components/features/billing/resume-subscription-button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requireTenant } from '@/lib/auth/helpers';
import { PLAN_CATALOG } from '@/lib/billing/plans';
import { getBillingOverviewAction } from '@/server/actions/billing-management';

/**
 * Billing settings — fully native HeyHenry UI for plan, payment method,
 * invoice history, and self-serve cancel/pause. Replaces the previous
 * redirect-to-Stripe-Customer-Portal flow so customers stay in-app.
 *
 * Dates render in the tenant's timezone (not the viewer's local) so a
 * "next renewal Mon Jun 3" message matches what the customer sees on the
 * invoice rather than shifting by a day across the date line.
 */
export default async function BillingPage() {
  const { tenant } = await requireTenant();
  const overview = await getBillingOverviewAction();
  const tz = tenant.timezone;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground">
          Your plan, payment method, invoices, and subscription. See the{' '}
          <Link href="/refund-policy" className="underline underline-offset-2">
            refund policy
          </Link>{' '}
          for what happens when you cancel.
        </p>
      </div>

      {!overview.hasSubscription ? (
        <Card>
          <CardHeader>
            <div className="flex items-start gap-2">
              <Sparkles className="size-5 mt-0.5" />
              <div>
                <CardTitle>No active subscription</CardTitle>
                <CardDescription>
                  Pick a plan to unlock the full HeyHenry feature set.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <Link href="/onboarding/plan" className="text-sm underline underline-offset-2">
              Choose a plan →
            </Link>
          </CardContent>
        </Card>
      ) : (
        <>
          <CurrentPlanCard overview={overview} tz={tz} />
          <PaymentMethodCard card={overview.defaultCard} />
          <ChangePlanCard currentPlan={overview.plan} currentCycle={overview.cycle} />
          <InvoicesTable />
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
        </>
      )}
    </div>
  );
}

function CurrentPlanCard({
  overview,
  tz,
}: {
  overview: Extract<
    Awaited<ReturnType<typeof getBillingOverviewAction>>,
    { hasSubscription: true }
  >;
  tz: string;
}) {
  const planCopy = PLAN_CATALOG[overview.plan];
  const renewalDate = overview.currentPeriodEnd ? formatDate(overview.currentPeriodEnd, tz) : null;
  const trialDate = overview.trialEndsAt ? formatDate(overview.trialEndsAt, tz) : null;
  const paused = overview.pausedUntil !== null;
  const pausedUntilDate =
    overview.pausedUntil && overview.pausedUntil !== 'indefinite'
      ? formatDate(overview.pausedUntil, tz)
      : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Sparkles className="size-5 mt-0.5" />
            <div>
              <CardTitle>
                {planCopy.name} plan ·{' '}
                <span className="text-muted-foreground capitalize">{overview.cycle}</span>
              </CardTitle>
              <CardDescription>{planCopy.tagline}</CardDescription>
            </div>
          </div>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground capitalize">
            {paused ? 'paused' : overview.status.replace('_', ' ')}
          </span>
        </div>
      </CardHeader>
      <CardContent className="text-sm space-y-1 text-muted-foreground">
        {paused ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p>
              Subscription paused.
              {pausedUntilDate ? <> Resumes automatically {pausedUntilDate}.</> : null}
            </p>
            <ResumeSubscriptionButton />
          </div>
        ) : null}
        {!paused && overview.status === 'trialing' && trialDate ? (
          <p>Trial ends {trialDate}.</p>
        ) : null}
        {!paused && overview.status !== 'trialing' && renewalDate && !overview.cancelAtPeriodEnd ? (
          <p>Next renewal {renewalDate}.</p>
        ) : null}
        {overview.cancelAtPeriodEnd && renewalDate ? (
          <p>Cancellation pending. Access continues until {renewalDate}.</p>
        ) : null}
        {overview.promoCode ? (
          <p>
            Promo applied: <strong>{overview.promoCode}</strong>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
