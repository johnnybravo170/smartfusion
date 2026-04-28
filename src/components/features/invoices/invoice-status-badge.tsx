import { Badge } from '@/components/ui/badge';
import { invoiceStatusTone, statusToneClass, statusToneIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import type { InvoiceStatus } from '@/lib/validators/invoice';

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const tone = invoiceStatusTone[status];
  const Icon = statusToneIcon[tone];
  return (
    <Badge
      variant="secondary"
      className={cn('gap-1 font-medium capitalize', statusToneClass[tone])}
      data-slot="invoice-status-badge"
    >
      <Icon aria-hidden="true" className="size-3" />
      {status}
    </Badge>
  );
}
