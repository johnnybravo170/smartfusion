import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { type WorklogEntryType, worklogEntryTypeLabels } from '@/lib/validators/worklog';

const STYLES: Record<WorklogEntryType, string> = {
  note: 'bg-sky-100 text-sky-800 border-sky-200',
  system: 'bg-muted text-muted-foreground border-muted-foreground/20',
  milestone: 'bg-amber-100 text-amber-800 border-amber-200',
};

export function WorklogEntryTypeBadge({
  entryType,
  className,
}: {
  entryType: WorklogEntryType;
  className?: string;
}) {
  return (
    <Badge
      data-slot="worklog-entry-type-badge"
      data-entry-type={entryType}
      variant="outline"
      className={cn(
        'font-medium border uppercase tracking-wide text-[10px]',
        STYLES[entryType],
        className,
      )}
    >
      {worklogEntryTypeLabels[entryType]}
    </Badge>
  );
}
