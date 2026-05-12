import { EstimatingDetailLevelCard } from '@/components/features/settings/estimating-detail-level-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getEstimatingDetailLevel } from '@/server/actions/estimating-prefs';

export const metadata = { title: 'Estimating — Settings' };

export default async function EstimatingPage() {
  const level = await getEstimatingDetailLevel();
  return (
    <>
      <SettingsPageHeader
        title="Estimating detail level"
        description="How granular Henry's AI-scaffolded estimates start out. You can always edit before sending."
      />
      <EstimatingDetailLevelCard currentLevel={level} />
    </>
  );
}
