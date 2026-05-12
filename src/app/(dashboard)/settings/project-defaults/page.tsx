import { ProjectDefaultsCard } from '@/components/features/settings/project-defaults-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getDefaultManagementFeeRate } from '@/server/actions/project-defaults';

export const metadata = { title: 'Project defaults — Settings' };

export default async function ProjectDefaultsPage() {
  const rate = await getDefaultManagementFeeRate();
  return (
    <>
      <SettingsPageHeader
        title="Project defaults"
        description="Defaults applied when a new project is created. Override per-project as needed."
      />
      <ProjectDefaultsCard defaultManagementFeeRate={rate} />
    </>
  );
}
