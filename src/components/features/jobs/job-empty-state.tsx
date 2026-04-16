import { ClipboardList } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Centered empty state for the jobs list/board. Two variants:
 * - "fresh" (no jobs at all) encourages creating the first one
 * - "filtered" (jobs exist but filters returned zero) encourages clearing
 *   the filter
 */
export function JobEmptyState({ variant }: { variant: 'fresh' | 'filtered' }) {
  if (variant === 'filtered') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card py-16 text-center">
        <p className="text-sm font-medium">No jobs match those filters.</p>
        <p className="text-sm text-muted-foreground">
          Adjust the status or customer filter, or clear filters to see everything.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/jobs/list">Clear filters</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed bg-card py-20 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ClipboardList className="size-6 text-muted-foreground" aria-hidden />
      </div>
      <div className="space-y-1">
        <h2 className="text-base font-semibold">No jobs yet</h2>
        <p className="text-sm text-muted-foreground">
          Schedule your first job to see it on the board.
        </p>
      </div>
      <Button asChild>
        <Link href="/jobs/new">Schedule a job</Link>
      </Button>
    </div>
  );
}
