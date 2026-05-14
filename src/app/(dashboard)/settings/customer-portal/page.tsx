import { Eye } from 'lucide-react';
import { notFound } from 'next/navigation';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { TenantPortalSettingsForm } from '@/components/features/settings/tenant-portal-settings-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Customer portal — Settings' };

/**
 * Tenant-wide defaults for the customer portal — what every customer sees
 * unless their project overrides on its Portal tab. Split out of Business
 * profile because the audience here is "what customers experience," not
 * "what your business looks like."
 */
export default async function CustomerPortalSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const supabase = await createClient();
  const { data: tenantSettings } = await supabase
    .from('tenants')
    .select('portal_show_budget, notify_customer_on_schedule_change')
    .eq('id', tenant.id)
    .maybeSingle();

  const portalShowBudget = Boolean(tenantSettings?.portal_show_budget);
  const notifyOnScheduleChange = Boolean(tenantSettings?.notify_customer_on_schedule_change);

  return (
    <>
      <SettingsPageHeader
        title="Customer portal"
        description="What your customers see on their project portal by default. Per-project overrides live on each project's Portal tab."
      />
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Eye className="size-5" />
            <div>
              <CardTitle>Portal defaults</CardTitle>
              <CardDescription>
                Applied to every project unless the project's own Portal tab overrides.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <TenantPortalSettingsForm
            initialShowBudget={portalShowBudget}
            initialNotifyOnScheduleChange={notifyOnScheduleChange}
          />
        </CardContent>
      </Card>
    </>
  );
}
