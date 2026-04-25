import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { requireTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Subscription started — HeyHenry' };

/**
 * Stripe Checkout success landing. The webhook is what actually flips
 * the tenant's plan + status — by the time the user reads this page the
 * webhook may not have fired yet. Show a friendly waiting state if the
 * subscription isn't recorded yet; the user can refresh.
 */
export default async function CheckoutSuccessPage() {
  const { tenant } = await requireTenant();

  const admin = createAdminClient();
  const { data: row } = await admin
    .from('tenants')
    .select('stripe_subscription_id, plan')
    .eq('id', tenant.id)
    .single();

  if (row?.stripe_subscription_id) redirect('/dashboard');

  return (
    <div className="mx-auto max-w-md py-12">
      <Card>
        <CardHeader>
          <CardTitle>Almost there…</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm text-muted-foreground">
          <p>Stripe is finishing setting up your subscription. This usually takes a few seconds.</p>
          <p>Refresh the page in a moment to continue.</p>
          <Button asChild className="w-full">
            <Link href="/onboarding/plan/success">Refresh</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
