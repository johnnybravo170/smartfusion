import { PipelineSummary } from '@/components/features/dashboard/pipeline-summary';
import { RenovationPipelineSummary } from '@/components/features/dashboard/renovation-pipeline-summary';
import { requireTenant } from '@/lib/auth/helpers';
import { getPipelineMetrics, getRenovationPipelineMetrics } from '@/lib/db/queries/dashboard';

export async function PipelineSection() {
  const { tenant } = await requireTenant();
  const tz = tenant.timezone;
  const isRenovation = tenant.vertical === 'renovation' || tenant.vertical === 'tile';

  if (isRenovation) {
    const metrics = await getRenovationPipelineMetrics(tz);
    return metrics ? <RenovationPipelineSummary metrics={metrics} /> : null;
  }

  const metrics = await getPipelineMetrics();
  return metrics ? <PipelineSummary metrics={metrics} /> : null;
}
