import { ChecklistSettingsCard } from '@/components/features/settings/checklist-settings-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = { title: 'Checklist — Settings' };

export default async function ChecklistSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) return null;
  const { getChecklistHideHours } = await import('@/lib/db/queries/project-checklist');
  const hours = await getChecklistHideHours(tenant.id);
  return (
    <>
      <SettingsPageHeader
        title="Checklist settings"
        description="How long completed checklist items stay visible before they hide."
      />
      <ChecklistSettingsCard currentHours={hours} />
    </>
  );
}
