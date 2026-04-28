import type { WorkerInvoiceStatus } from '@/lib/db/queries/worker-invoices';
import { statusToneClass, statusToneIcon, workerInvoiceStatusTone } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';

const LABELS: Record<WorkerInvoiceStatus, string> = {
  draft: 'Draft',
  submitted: 'Submitted',
  approved: 'Approved',
  rejected: 'Rejected',
  paid: 'Paid',
};

export function InvoiceStatusBadge({ status }: { status: WorkerInvoiceStatus }) {
  const tone = workerInvoiceStatusTone[status];
  const Icon = statusToneIcon[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium',
        statusToneClass[tone],
      )}
    >
      <Icon aria-hidden="true" className="size-3" />
      {LABELS[status]}
    </span>
  );
}
