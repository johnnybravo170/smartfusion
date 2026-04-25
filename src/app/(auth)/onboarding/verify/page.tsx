import { redirect } from 'next/navigation';
import { VerifyOnboarding } from '@/components/features/onboarding/verify-onboarding';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Verify your account — HeyHenry',
};

type SearchParams = Promise<{ plan?: string; billing?: string }>;

export default async function VerifyOnboardingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [user, tenant, params] = await Promise.all([
    getCurrentUser(),
    getCurrentTenant(),
    searchParams,
  ]);
  if (!user) redirect('/login');
  if (!tenant) redirect('/signup?error=no_tenant');

  const admin = createAdminClient();
  const { data: member } = await admin
    .from('tenant_members')
    .select('phone, phone_verified_at')
    .eq('user_id', user.id)
    .eq('tenant_id', tenant.id)
    .maybeSingle();

  const emailVerified = !!user.email_confirmed_at;
  const phoneVerified = !!member?.phone_verified_at;

  // Already done — forward to plan-pick (or dashboard if already subscribed,
  // which the plan page resolves itself).
  if (emailVerified && phoneVerified) {
    const qs = new URLSearchParams();
    if (params.plan) qs.set('plan', params.plan);
    if (params.billing) qs.set('billing', params.billing);
    const tail = qs.toString();
    redirect(tail ? `/onboarding/plan?${tail}` : '/onboarding/plan');
  }

  return (
    <VerifyOnboarding
      email={user.email ?? ''}
      emailVerified={emailVerified}
      phone={(member?.phone as string | null) ?? ''}
      phoneVerified={phoneVerified}
    />
  );
}
