'use server';

import { requireTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Polled by the Stripe Checkout success page to detect when the webhook
 * has landed. Reading is admin-scoped because the user has an active
 * session but RLS on `tenants` may block self-reads from the current
 * member context — admin client guarantees we see the row.
 */
export async function checkSubscriptionStatusAction(): Promise<{ active: boolean }> {
  const { tenant } = await requireTenant();
  const admin = createAdminClient();
  const { data } = await admin
    .from('tenants')
    .select('stripe_subscription_id')
    .eq('id', tenant.id)
    .single();
  return { active: Boolean(data?.stripe_subscription_id) };
}
