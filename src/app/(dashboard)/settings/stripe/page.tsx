import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { StripeConnectCard } from '@/components/features/settings/stripe-connect-card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Stripe — Settings' };

export default async function StripeSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('stripe_account_id, stripe_onboarded_at')
    .eq('id', tenant.id)
    .single();

  return (
    <>
      <SettingsPageHeader
        title="Stripe"
        description="Accept card payments on invoices. Connects through Stripe's hosted onboarding."
      />
      <StripeConnectCard
        stripeAccountId={(data?.stripe_account_id as string) ?? null}
        stripeOnboardedAt={(data?.stripe_onboarded_at as string) ?? null}
      />
    </>
  );
}
