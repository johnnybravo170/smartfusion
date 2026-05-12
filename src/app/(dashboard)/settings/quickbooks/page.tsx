import Link from 'next/link';
import { QuickBooksConnectCard } from '@/components/features/settings/quickbooks-connect-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'QuickBooks — Settings' };

export default async function QuickBooksSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data } = await supabase
    .from('tenants')
    .select('qbo_realm_id, qbo_company_name, qbo_connected_at, qbo_environment')
    .eq('id', tenant.id)
    .single();

  const connected = !!data?.qbo_realm_id;

  return (
    <>
      <SettingsPageHeader
        title="QuickBooks"
        description="Sync invoices, customers, and chart-of-accounts mappings to your QuickBooks Online file."
      />
      <div className="space-y-4">
        <QuickBooksConnectCard
          realmId={(data?.qbo_realm_id as string) ?? null}
          companyName={(data?.qbo_company_name as string) ?? null}
          connectedAt={(data?.qbo_connected_at as string) ?? null}
          environment={(data?.qbo_environment as 'sandbox' | 'production') ?? null}
        />
        {connected ? (
          <div className="grid gap-3 sm:grid-cols-3">
            <Link href="/settings/qbo-class-mapping" className="block">
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-sm">Class mapping</CardTitle>
                  <CardDescription className="text-xs">
                    Map HeyHenry categories to QBO classes.
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
            <Link href="/settings/qbo-review" className="block">
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-sm">Review queue</CardTitle>
                  <CardDescription className="text-xs">
                    Items awaiting confirmation before sync.
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
            <Link href="/settings/qbo-history" className="block">
              <Card className="h-full transition-colors hover:bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-sm">Sync history</CardTitle>
                  <CardDescription className="text-xs">
                    Past syncs, errors, and re-tries.
                  </CardDescription>
                </CardHeader>
              </Card>
            </Link>
          </div>
        ) : null}
      </div>
    </>
  );
}
