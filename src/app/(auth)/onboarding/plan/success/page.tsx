import { redirect } from 'next/navigation';
import { requireTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';
import { SubscriptionStatusPoller } from './poller';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Subscription started — HeyHenry' };

/**
 * Stripe Checkout success landing. The Stripe webhook writes
 * `tenants.stripe_subscription_id` — by the time the customer hits this
 * page the webhook usually has already fired. If so, redirect to
 * /dashboard immediately. Otherwise hand off to a client poller so the
 * customer doesn't have to manually refresh.
 */
export default async function CheckoutSuccessPage() {
  const { tenant } = await requireTenant();

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();

  if (row?.stripe_subscription_id) redirect('/dashboard');

  return <SubscriptionStatusPoller />;
}
