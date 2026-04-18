import { cn } from '@/lib/utils';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';
import { changeOrderStatusLabels } from '@/lib/validators/change-order';

const statusColors: Record<ChangeOrderStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  pending_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  declined: 'bg-red-100 text-red-800',
  voided: 'bg-gray-100 text-gray-500',
};

export function ChangeOrderStatusBadge({ status }: { status: ChangeOrderStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        statusColors[status] ?? 'bg-gray-100 text-gray-800',
      )}
    >
      {changeOrderStatusLabels[status] ?? status}
    </span>
  );
}
