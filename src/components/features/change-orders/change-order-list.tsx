import Link from 'next/link';
import type { ChangeOrderRow } from '@/lib/db/queries/change-orders';
import { formatCurrency } from '@/lib/pricing/calculator';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';
import { ChangeOrderStatusBadge } from './change-order-status-badge';

export function ChangeOrderList({
  changeOrders,
  projectId,
  jobId,
  timezone,
}: {
  changeOrders: ChangeOrderRow[];
  projectId?: string;
  jobId?: string;
  timezone: string;
}) {
  const basePath = projectId ? `/projects/${projectId}` : `/jobs/${jobId}`;
  const newHref = `${basePath}/change-orders/new`;

  if (changeOrders.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">No change orders yet.</p>
        <Link
          href={newHref}
          className="mt-3 inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Create Change Order
        </Link>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-3 py-2 text-left font-medium">Title</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">Cost Impact</th>
            <th className="px-3 py-2 text-right font-medium">Timeline</th>
            <th className="px-3 py-2 text-left font-medium">Date</th>
          </tr>
        </thead>
        <tbody>
          {changeOrders.map((co) => {
            const detailPath = co.project_id
              ? `/projects/${co.project_id}/change-orders/${co.id}`
              : `/jobs/${co.job_id}/change-orders/${co.id}`;
            return (
              <tr key={co.id} className="border-b last:border-0 hover:bg-muted/30">
                <td className="px-3 py-2">
                  <Link href={detailPath} className="font-medium hover:underline">
                    {co.title}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <ChangeOrderStatusBadge status={co.status as ChangeOrderStatus} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {co.cost_impact_cents >= 0 ? '+' : ''}
                  {formatCurrency(co.cost_impact_cents)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {co.timeline_impact_days === 0
                    ? 'None'
                    : `${co.timeline_impact_days > 0 ? '+' : ''}${co.timeline_impact_days}d`}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {new Intl.DateTimeFormat('en-CA', {
                    timeZone: timezone,
                    month: 'short',
                    day: 'numeric',
                  }).format(new Date(co.created_at))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
