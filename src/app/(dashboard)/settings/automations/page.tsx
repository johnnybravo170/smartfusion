import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AutomationsCard } from '@/components/features/settings/automations-card';
import { resolveTenantAutoFollowupEnabled } from '@/lib/ar/system-sequences';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { hasFeature } from '@/lib/billing/features';

export const dynamic = 'force-dynamic';

export default async function AutomationsSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) redirect('/login');

  const quoteFollowupEnabled = await resolveTenantAutoFollowupEnabled(tenant.id);
  const featureUnlocked = hasFeature(
    { plan: tenant.plan, subscriptionStatus: tenant.subscriptionStatus },
    'customers.followup_sequences',
  );

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
      </div>

      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
        <p className="text-sm text-muted-foreground">
          Background sequences Henry runs on your behalf.
        </p>
      </div>

      <AutomationsCard initialEnabled={quoteFollowupEnabled} featureUnlocked={featureUnlocked} />
    </div>
  );
}
