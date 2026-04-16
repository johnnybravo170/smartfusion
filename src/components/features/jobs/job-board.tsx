'use client';

/**
 * Kanban board for jobs. Four columns, drag-and-drop powered by @dnd-kit.
 *
 * Drops trigger `changeJobStatusAction`, which both updates the job row and
 * writes a `worklog_entries` row so the status history is auditable. We run
 * the action inside `useTransition` and flip state optimistically — on
 * failure, we revert and show a toast.
 *
 * The board is keyboard-accessible through dnd-kit's keyboard sensor. For
 * users or test runners that don't want to drag, `JobStatusSelect` on the
 * detail page exposes the same transition.
 */

import {
  closestCorners,
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import type { JobBoardData, JobWithCustomer } from '@/lib/db/queries/jobs';
import { cn } from '@/lib/utils';
import { type JobStatus, jobStatuses, jobStatusLabels } from '@/lib/validators/job';
import { changeJobStatusAction } from '@/server/actions/jobs';
import { JobCard } from './job-card';

type BoardState = Record<JobStatus, JobWithCustomer[]>;

function toBoardState(data: JobBoardData): BoardState {
  return {
    booked: [...data.booked],
    in_progress: [...data.in_progress],
    complete: [...data.complete],
    cancelled: [...data.cancelled],
  };
}

function findContainer(board: BoardState, jobId: string): JobStatus | null {
  for (const status of jobStatuses) {
    if (board[status].some((j) => j.id === jobId)) return status;
  }
  return null;
}

export function JobBoard({ board }: { board: JobBoardData }) {
  const [state, setState] = useState<BoardState>(() => toBoardState(board));
  const [, startTransition] = useTransition();
  const [activeJob, setActiveJob] = useState<JobWithCustomer | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    const container = findContainer(state, id);
    if (!container) return;
    const job = state[container].find((j) => j.id === id) ?? null;
    setActiveJob(job);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveJob(null);
    const { active, over } = event;
    if (!over) return;

    const jobId = String(active.id);
    const fromStatus = findContainer(state, jobId);
    if (!fromStatus) return;

    // `over.id` is either another job id (dropped on a sibling) or a
    // container id (dropped on the column itself).
    const overId = String(over.id);
    const toStatus: JobStatus | null = (jobStatuses as readonly string[]).includes(overId)
      ? (overId as JobStatus)
      : findContainer(state, overId);
    if (!toStatus || toStatus === fromStatus) return;

    const previous = state;
    const job = state[fromStatus].find((j) => j.id === jobId);
    if (!job) return;

    // Optimistic update.
    setState({
      ...state,
      [fromStatus]: state[fromStatus].filter((j) => j.id !== jobId),
      [toStatus]: [{ ...job, status: toStatus }, ...state[toStatus]],
    });

    startTransition(async () => {
      const result = await changeJobStatusAction({ id: jobId, status: toStatus });
      if (!result.ok) {
        setState(previous);
        toast.error(result.error);
        return;
      }
      toast.success(`Moved to ${jobStatusLabels[toStatus]}`);
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {jobStatuses.map((status) => (
          <BoardColumn key={status} status={status} jobs={state[status]} />
        ))}
      </div>
      <DragOverlay>
        {activeJob ? <JobCard job={activeJob} draggable className="rotate-1 shadow-lg" /> : null}
      </DragOverlay>
    </DndContext>
  );
}

const COLUMN_STYLES: Record<JobStatus, string> = {
  booked: 'border-sky-200 bg-sky-50/40',
  in_progress: 'border-amber-200 bg-amber-50/40',
  complete: 'border-emerald-200 bg-emerald-50/40',
  cancelled: 'border-slate-200 bg-slate-50/40',
};

function BoardColumn({ status, jobs }: { status: JobStatus; jobs: JobWithCustomer[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const ids = useMemo(() => jobs.map((j) => j.id), [jobs]);

  return (
    <section
      ref={setNodeRef}
      data-testid={`board-column-${status}`}
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-3 transition-colors',
        COLUMN_STYLES[status],
        isOver && 'ring-2 ring-primary/40',
      )}
    >
      <header className="flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
          {jobStatusLabels[status]}
        </h2>
        <span className="rounded-full bg-white/80 px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {jobs.length}
        </span>
      </header>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className="flex min-h-[60px] flex-col gap-2">
          {jobs.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">Nothing here yet</p>
          ) : (
            jobs.map((job) => <SortableJobCard key={job.id} job={job} />)
          )}
        </div>
      </SortableContext>
    </section>
  );
}

function SortableJobCard({ job }: { job: JobWithCustomer }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: job.id,
  });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <JobCard job={job} draggable />
    </div>
  );
}
