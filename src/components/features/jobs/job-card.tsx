import { CalendarClock } from 'lucide-react';
import Link from 'next/link';
import type { JobWithCustomer } from '@/lib/db/queries/jobs';
import { cn } from '@/lib/utils';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function truncate(value: string, max = 120) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Compact card used by the kanban board. Clicking navigates to the detail
 * page; the wrapper card itself is a <Link> so the entire surface is
 * clickable. The drag handle is rendered outside the link in
 * `SortableJobCard`.
 */
export function JobCard({
  job,
  className,
  draggable,
}: {
  job: JobWithCustomer;
  className?: string;
  draggable?: boolean;
}) {
  const customerName = job.customer?.name ?? 'Unknown customer';
  const scheduled = job.scheduled_at ? dateFormatter.format(new Date(job.scheduled_at)) : null;
  const notesPreview = job.notes ? truncate(job.notes.split('\n')[0] ?? '', 90) : null;

  return (
    <Link
      href={`/jobs/${job.id}`}
      className={cn(
        'group flex flex-col gap-2 rounded-lg border bg-card p-3 text-sm shadow-sm transition-all',
        'hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md',
        draggable && 'cursor-grab active:cursor-grabbing',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-foreground group-hover:text-primary">{customerName}</span>
      </div>
      {scheduled ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <CalendarClock className="size-3.5" aria-hidden />
          <span>{scheduled}</span>
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No date set</div>
      )}
      {notesPreview ? (
        <p className="line-clamp-1 text-xs text-muted-foreground">{notesPreview}</p>
      ) : null}
    </Link>
  );
}
