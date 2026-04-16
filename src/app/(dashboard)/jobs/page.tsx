import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { BoardViewToggle } from '@/components/features/jobs/board-view-toggle';
import { JobBoard } from '@/components/features/jobs/job-board';
import { JobEmptyState } from '@/components/features/jobs/job-empty-state';
import { Button } from '@/components/ui/button';
import { countJobsByStatus, getBoardData } from '@/lib/db/queries/jobs';

export const metadata = {
  title: 'Jobs — Smartfusion',
};

export default async function JobsPage() {
  const [board, counts] = await Promise.all([getBoardData(), countJobsByStatus()]);
  const total = counts.booked + counts.in_progress + counts.complete + counts.cancelled;
  const activeTotal = counts.booked + counts.in_progress;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jobs</h1>
          <p className="text-sm text-muted-foreground">
            {total === 0
              ? 'Nothing scheduled yet.'
              : `${activeTotal} active · ${counts.complete} complete`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Suspense fallback={null}>
            <BoardViewToggle />
          </Suspense>
          <Button asChild>
            <Link href="/jobs/new">
              <Plus className="size-3.5" />
              New job
            </Link>
          </Button>
        </div>
      </header>

      {total === 0 ? <JobEmptyState variant="fresh" /> : <JobBoard board={board} />}
    </div>
  );
}
