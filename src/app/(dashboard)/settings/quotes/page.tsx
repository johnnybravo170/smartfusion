import { PublicQuoteLinkCard } from '@/components/features/settings/public-quote-link-card';
import { QuoteSettingsCard } from '@/components/features/settings/quote-settings-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Quotes — Settings' };

export default async function QuotesSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('quote_validity_days')
    .eq('id', tenant.id)
    .single();

  const validityDays = (data?.quote_validity_days as number) ?? 30;

  return (
    <>
      <SettingsPageHeader
        title="Quotes"
        description="Defaults for the customer-facing quote document and the public quote link."
      />
      <div className="space-y-4">
        <QuoteSettingsCard currentValidityDays={validityDays} />
        <PublicQuoteLinkCard currentSlug={tenant.slug} businessName={tenant.name} />
      </div>
    </>
  );
}
