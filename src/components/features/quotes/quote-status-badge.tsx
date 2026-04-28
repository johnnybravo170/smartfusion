import { Badge } from '@/components/ui/badge';
import { quoteStatusTone, statusToneClass, statusToneIcon } from '@/lib/ui/status-tokens';
import { cn } from '@/lib/utils';
import { type QuoteStatus, quoteStatusLabels } from '@/lib/validators/quote';

export function QuoteStatusBadge({
  status,
  className,
}: {
  status: QuoteStatus;
  className?: string;
}) {
  const tone = quoteStatusTone[status];
  const Icon = statusToneIcon[tone];
  return (
    <Badge
      data-slot="quote-status-badge"
      data-status={status}
      variant="outline"
      className={cn('gap-1 font-medium border', statusToneClass[tone], className)}
    >
      <Icon aria-hidden="true" className="size-3" />
      {quoteStatusLabels[status]}
    </Badge>
  );
}
