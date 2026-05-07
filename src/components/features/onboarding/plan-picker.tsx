'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { Plan } from '@/lib/billing/features';
import { type BillingCycle, formatCad, PLAN_CATALOG, type PlanCopy } from '@/lib/billing/plans';
import { cn } from '@/lib/utils';
import { startCheckoutAction } from '@/server/actions/billing';

// Self-serve picker shows Growth only. Other tiers (Starter, Pro, Scale)
// still exist (prices, feature gates, Stripe products) but are direct-sales
// for now — keeping the signup surface focused on the one plan we want
// early customers on.
const PLAN_ORDER: Plan[] = ['growth'];

type Props = {
  initialPlan: Plan | null;
  initialCycle: BillingCycle;
  initialPromo: string | null;
  skipTrial: boolean;
};

export function PlanPicker({ initialPlan, initialCycle, initialPromo, skipTrial }: Props) {
  const [cycle, setCycle] = useState<BillingCycle>(initialCycle);
  const [selectedPlan, setSelectedPlan] = useState<Plan>(initialPlan ?? 'growth');
  const [pending, startTransition] = useTransition();

  function handleContinue() {
    startTransition(async () => {
      const res = await startCheckoutAction({
        plan: selectedPlan,
        billing: cycle,
        promo: initialPromo,
      });
      if (res && 'error' in res) {
        toast.error(res.error);
      }
      // Success → server-side redirect to Stripe Checkout
    });
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 py-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold">Pick your plan</h1>
        <p className="text-muted-foreground">
          {skipTrial
            ? 'Card charged today. Change or cancel anytime.'
            : '14-day free trial. Card required. Change or cancel anytime.'}
        </p>
        {initialPromo ? (
          <p className="text-sm font-medium text-emerald-600">
            Promo code <span className="font-mono">{initialPromo}</span> applied at checkout
            {initialPromo.toUpperCase() === 'FOUNDER'
              ? ' — Growth $199/mo CAD (regular $399).'
              : '.'}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Have a promo code? You can enter it at checkout.
          </p>
        )}
      </div>

      <div className="flex justify-center">
        <div className="inline-flex rounded-lg border bg-muted p-1 text-sm">
          <button
            type="button"
            onClick={() => setCycle('monthly')}
            className={cn(
              'rounded-md px-4 py-1.5 transition',
              cycle === 'monthly' ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setCycle('yearly')}
            className={cn(
              'rounded-md px-4 py-1.5 transition',
              cycle === 'yearly' ? 'bg-background shadow-sm' : 'text-muted-foreground',
            )}
          >
            Yearly <span className="ml-1 text-xs text-emerald-600">20% off</span>
          </button>
        </div>
      </div>

      <div className="mx-auto w-full max-w-md">
        {PLAN_ORDER.map((plan) => (
          <PlanCard
            key={plan}
            copy={PLAN_CATALOG[plan]}
            cycle={cycle}
            selected={selectedPlan === plan}
            onSelect={() => setSelectedPlan(plan)}
          />
        ))}
      </div>

      <div className="flex justify-center">
        <Button size="lg" onClick={handleContinue} disabled={pending} className="min-w-64">
          {pending
            ? 'Redirecting…'
            : skipTrial
              ? `Continue with ${PLAN_CATALOG[selectedPlan].name} — pay today`
              : `Continue with ${PLAN_CATALOG[selectedPlan].name} — start 14-day trial`}
        </Button>
      </div>
    </div>
  );
}

function PlanCard({
  copy,
  cycle,
  selected,
  onSelect,
}: {
  copy: PlanCopy;
  cycle: BillingCycle;
  selected: boolean;
  onSelect: () => void;
}) {
  const cents = cycle === 'monthly' ? copy.monthlyCadCents : copy.yearlyCadCents;
  const suffix = cycle === 'monthly' ? '/mo CAD' : '/yr CAD';
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'cursor-pointer transition',
        selected ? 'border-primary ring-2 ring-primary/30' : 'hover:border-muted-foreground/40',
      )}
    >
      <CardHeader>
        <CardTitle>{copy.name}</CardTitle>
        <CardDescription>{copy.tagline}</CardDescription>
        <div className="pt-2">
          <span className="text-3xl font-semibold">{formatCad(cents)}</span>
          <span className="text-sm text-muted-foreground"> {suffix}</span>
        </div>
        <p className="text-xs text-muted-foreground">{copy.seatBand}</p>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1.5 text-sm">
          {copy.highlights.map((h) => (
            <li key={h} className="flex gap-2">
              <span className="text-muted-foreground">•</span>
              <span>{h}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
