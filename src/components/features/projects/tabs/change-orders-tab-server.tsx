import Link from 'next/link';
import { ChangeOrderList } from '@/components/features/change-orders/change-order-list';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listChangeOrders } from '@/lib/db/queries/change-orders';

export default async function ChangeOrdersTabServer({ projectId }: { projectId: string }) {
  const [changeOrders, tenant] = await Promise.all([
    listChangeOrders({ projectId }),
    getCurrentTenant(),
  ]);
  const tz = tenant?.timezone ?? 'America/Vancouver';

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Link
          href={`/projects/${projectId}/change-orders/new`}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New Change Order
        </Link>
      </div>
      <ChangeOrderList changeOrders={changeOrders} projectId={projectId} timezone={tz} />
    </div>
  );
}
