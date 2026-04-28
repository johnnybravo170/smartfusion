import { changeOrderStatusTone, statusToneClass, statusToneIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import type { ChangeOrderStatus } from '@/lib/validators/change-order';
import { changeOrderStatusLabels } from '@/lib/validators/change-order';

export function ChangeOrderStatusBadge({ status }: { status: ChangeOrderStatus }) {
  const tone = changeOrderStatusTone[status] ?? 'neutral';
  const Icon = statusToneIcon[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        statusToneClass[tone],
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {changeOrderStatusLabels[status] ?? status}
    </span>
  );
}
