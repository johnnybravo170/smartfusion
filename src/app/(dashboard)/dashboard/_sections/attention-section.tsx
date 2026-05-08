import { ChecklistDashboardChip } from '@/components/features/checklist/dashboard-chip';
import { CommandCenter, PersonalTasksCard } from '@/components/features/dashboard/command-center';
import { EstimateCelebrationCard } from '@/components/features/dashboard/estimate-celebration-card';
import { MoneyAtRiskCard } from '@/components/features/dashboard/money-at-risk-card';
import { getCurrentUser, requireTenant } from '@/lib/auth/helpers';
import { listPendingChangeOrdersForDashboard } from '@/lib/db/queries/change-orders';
import { getPendingEstimateCelebration } from '@/lib/db/queries/estimate-celebrations';
import { listMoneyAtRisk } from '@/lib/db/queries/money-at-risk';
import {
  getDashboardTaskBuckets,
  getJobTaskHealth,
  listTasksAwaitingVerification,
} from '@/lib/db/queries/tasks';

export async function AttentionSection() {
  const { tenant } = await requireTenant();
  const user = await getCurrentUser();
  const isRenovation = tenant.vertical === 'renovation' || tenant.vertical === 'tile';

  const [celebration, taskBuckets, jobTaskHealth, pendingChangeOrders, tasksToVerify, moneyAtRisk] =
    await Promise.all([
      getPendingEstimateCelebration(),
      user
        ? getDashboardTaskBuckets(user.id)
        : Promise.resolve({
            dueToday: [],
            overdue: [],
            blockedClient: [],
            blockedMaterial: [],
            blockedSub: [],
            blockedOther: [],
            personalTop: [],
          }),
      getJobTaskHealth(),
      listPendingChangeOrdersForDashboard(),
      listTasksAwaitingVerification(),
      listMoneyAtRisk(tenant.id),
    ]);

  return (
    <>
      {celebration ? <EstimateCelebrationCard celebration={celebration} /> : null}
      <ChecklistDashboardChip />
      <CommandCenter
        buckets={taskBuckets}
        jobHealth={jobTaskHealth}
        changeOrdersPending={pendingChangeOrders}
        tasksToVerify={tasksToVerify}
        showJobHealth={!isRenovation}
      />
      <MoneyAtRiskCard rows={moneyAtRisk} />
      <PersonalTasksCard tasks={taskBuckets.personalTop} />
    </>
  );
}
