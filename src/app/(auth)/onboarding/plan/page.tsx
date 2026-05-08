import { redirect } from 'next/navigation';
import { PlanPicker } from '@/components/features/onboarding/plan-picker';
import { requireTenant } from '@/lib/auth/helpers';
import { isBillingCycle, isPlan } from '@/lib/billing/plans';
import { createAdminClient } from '@/lib/supabase/admin';
import { resolvePromoEffects } from '@/server/actions/billing';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pick your plan — HeyHenry' };

type SearchParams = Promise<{
  plan?: string;
  billing?: string;
  canceled?: string;
  promo?: string;
}>;

export default async function OnboardingPlanPage({ searchParams }: { searchParams: SearchParams }) {
  const { tenant } = await requireTenant();

  // Personal workspaces don't have a paid plan surface — bounce out.
  if (tenant.vertical === 'personal') redirect('/dashboard');

  // Already subscribed → straight through to dashboard.
  const admin = createAdminClient();
  const { data: row } = await admin
    .from('tenants')
    .select('stripe_subscription_id, subscription_status')
    .eq('id', tenant.id)
    .single();
  if (row?.stripe_subscription_id) redirect('/dashboard');

  const params = await searchParams;
  const initialPlan = isPlan(params.plan) ? params.plan : null;
  const initialCycle = isBillingCycle(params.billing) ? params.billing : 'monthly';
  const initialPromo = typeof params.promo === 'string' ? params.promo.trim() || null : null;
  // Resolve promo server-side so we can show the right copy ("card charged
  // today" vs "14-day free trial") before the user clicks Continue. The
  // skip-trial flag is encoded in Stripe metadata on the promo code.
  const promoEffects = initialPromo
    ? await resolvePromoEffects(initialPromo)
    : { promotionCodeId: null, skipTrial: false };

  return (
    <PlanPicker
      initialPlan={initialPlan}
      initialCycle={initialCycle}
      initialPromo={promoEffects.promotionCodeId ? initialPromo : null}
      skipTrial={promoEffects.skipTrial}
    />
  );
}
