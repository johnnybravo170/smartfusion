import { redirect } from 'next/navigation';
import { VerifyOnboarding } from '@/components/features/onboarding/verify-onboarding';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Verify your account — HeyHenry',
};

export default async function VerifyOnboardingPage() {
  const [user, tenant] = await Promise.all([getCurrentUser(), getCurrentTenant()]);
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

  // Already done — bounce to dashboard.
  if (emailVerified && phoneVerified) redirect('/dashboard');

  return (
    <VerifyOnboarding
      email={user.email ?? ''}
      emailVerified={emailVerified}
      phone={(member?.phone as string | null) ?? ''}
      phoneVerified={phoneVerified}
    />
  );
}
