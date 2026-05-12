import { DataExportCard } from '@/components/features/settings/data-export-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Data export — Settings' };

export default async function DataExportSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;

  const supabase = await createClient();
  const { data: lastExport } = await supabase
    .from('data_exports')
    .select('download_url, created_at, status, expires_at')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const isExpired = lastExport?.expires_at
    ? new Date(lastExport.expires_at as string) < new Date()
    : true;

  return (
    <>
      <SettingsPageHeader
        title="Data export"
        description="Generate a downloadable archive of your projects, customers, and invoices."
      />
      <DataExportCard
        lastExportUrl={!isExpired ? ((lastExport?.download_url as string) ?? null) : null}
        lastExportDate={lastExport?.created_at ? (lastExport.created_at as string) : null}
      />
    </>
  );
}
