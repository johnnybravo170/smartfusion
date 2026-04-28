import { redirect } from 'next/navigation';
import { PlanPicker } from '@/components/features/onboarding/plan-picker';
import { requireTenant } from '@/lib/auth/helpers';
import { isBillingCycle, isPlan } from '@/lib/billing/plans';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Pick your plan — HeyHenry' };

type SearchParams = Promise<{ plan?: string; billing?: string; canceled?: string }>;

export default async function OnboardingPlanPage({ searchParams }: { searchParams: SearchParams }) {
  const { user, tenant } = await requireTenant();

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

  // Verification gate (mirrors dashboard layout).
  const phoneVerified = !!tenant.member.phone_verified_at;
  const emailVerified = !!user.email_confirmed_at;
  if (!emailVerified || !phoneVerified) redirect('/onboarding/verify');

  const params = await searchParams;
  const initialPlan = isPlan(params.plan) ? params.plan : null;
  const initialCycle = isBillingCycle(params.billing) ? params.billing : 'monthly';

  return <PlanPicker initialPlan={initialPlan} initialCycle={initialCycle} />;
}
