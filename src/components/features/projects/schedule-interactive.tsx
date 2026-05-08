'use client';

/**
 * Interactive operator Gantt — wraps `<ScheduleGantt>` with click-to-
 * edit, drag-to-reschedule, drag-to-resize, an "+ Add task" button,
 * and a "Clear & re-bootstrap" escape hatch.
 *
 * State lives here so the page-level tab-server stays a pure server
 * component; this is the single client boundary for the v1 edit UX.
 *
 * Drag persistence: pointerup fires `onTaskUpdate(taskId, patch)`
 * which calls `updateScheduleTaskAction` and refreshes the route. We
 * keep the optimistic patch in `pendingPatches` until the next render
 * (with persisted data) arrives, so the bar doesn't snap back to its
 * old position during the round-trip.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { ScheduleClearButton } from '@/components/features/projects/schedule-clear-button';
import { ScheduleGantt } from '@/components/features/projects/schedule-gantt';
import { ScheduleTaskEditor } from '@/components/features/projects/schedule-task-editor';
import { Button } from '@/components/ui/button';
import type { ProjectScheduleTask } from '@/lib/db/queries/project-schedule';
import {
  cancelScheduleNotifyAction,
  updateScheduleTaskAction,
} from '@/server/actions/project-schedule';

export type SchedulePhase = { id: string; name: string; display_order: number };

export function ScheduleInteractive({
  projectId,
  tasks,
  phases,
  tradeTypicalPhase,
  pendingNotifyAt,
}: {
  projectId: string;
  tasks: ProjectScheduleTask[];
  phases: SchedulePhase[];
  /** trade_template_id → trade.typical_phase (for color fallback when
   *  the project uses custom phase names that don't match canonical
   *  color-map keys). Plain object so it serializes as RSC props. */
  tradeTypicalPhase: Record<string, string>;
  /** ISO timestamp of the pending customer schedule-update notify, or
   *  null when no notify is queued (default tenant flag off, OR notify
   *  already sent/cancelled). Drives the Undo banner. */
  pendingNotifyAt: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editingTask, setEditingTask] = useState<ProjectScheduleTask | null>(null);
  const [creating, setCreating] = useState(false);
  // Optimistic patches keyed by taskId, applied to the visible Gantt
  // until the server-action round-trip + router.refresh() lands fresh
  // data. Clearing per-task when a refreshed task matches the patch.
  const [pendingPatches, setPendingPatches] = useState<
    Map<string, { planned_start_date?: string; planned_duration_days?: number }>
  >(new Map());

  // Apply pending patches on top of the server-rendered tasks so the
  // bar stays at its dragged position while the action persists.
  const visibleTasks = tasks.map((t) => {
    const p = pendingPatches.get(t.id);
    if (!p) return t;
    // If the persisted task already matches the patch, the round-trip
    // is done — drop the optimistic copy on the next render tick.
    const matches =
      (p.planned_start_date === undefined || p.planned_start_date === t.planned_start_date) &&
      (p.planned_duration_days === undefined ||
        p.planned_duration_days === t.planned_duration_days);
    if (matches) return t;
    return { ...t, ...p };
  });

  // Drop pending entries that the server has caught up to. Done as a
  // post-render side effect so we don't mutate during render.
  if (pendingPatches.size > 0) {
    let hasResolved = false;
    for (const [taskId, p] of pendingPatches.entries()) {
      const t = tasks.find((x) => x.id === taskId);
      if (!t) {
        hasResolved = true;
        break;
      }
      if (
        (p.planned_start_date === undefined || p.planned_start_date === t.planned_start_date) &&
        (p.planned_duration_days === undefined ||
          p.planned_duration_days === t.planned_duration_days)
      ) {
        hasResolved = true;
        break;
      }
    }
    if (hasResolved) {
      // Schedule clear after current commit so we don't update during render.
      Promise.resolve().then(() => {
        setPendingPatches((prev) => {
          const next = new Map(prev);
          for (const [taskId, p] of next.entries()) {
            const t = tasks.find((x) => x.id === taskId);
            if (
              !t ||
              ((p.planned_start_date === undefined ||
                p.planned_start_date === t.planned_start_date) &&
                (p.planned_duration_days === undefined ||
                  p.planned_duration_days === t.planned_duration_days))
            ) {
              next.delete(taskId);
            }
          }
          return next;
        });
      });
    }
  }

  const handleTaskUpdate = (
    taskId: string,
    patch: { planned_start_date?: string; planned_duration_days?: number },
  ) => {
    // Apply optimistically.
    setPendingPatches((prev) => {
      const next = new Map(prev);
      next.set(taskId, { ...(prev.get(taskId) ?? {}), ...patch });
      return next;
    });
    startTransition(async () => {
      const res = await updateScheduleTaskAction(taskId, patch);
      if (!res.ok) {
        // Roll back the optimistic patch on failure.
        setPendingPatches((prev) => {
          const next = new Map(prev);
          next.delete(taskId);
          return next;
        });
        alert(`Could not save: ${res.error}`);
        return;
      }
      router.refresh();
    });
  };

  // Default new tasks to the day after the last task ends, so the
  // operator's add-flow doesn't have to type a date for the common
  // "next thing in the sequence" case.
  const defaultStartDate = (() => {
    if (visibleTasks.length === 0) return new Date().toISOString().slice(0, 10);
    const ends = visibleTasks.map((t) => {
      const start = new Date(`${t.planned_start_date}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() + t.planned_duration_days);
      return start.getTime();
    });
    const lastEnd = new Date(Math.max(...ends));
    return lastEnd.toISOString().slice(0, 10);
  })();

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {visibleTasks.length} {visibleTasks.length === 1 ? 'task' : 'tasks'} · click to edit ·
          drag to reschedule · drag the right edge to resize
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
            + Add task
          </Button>
          <ScheduleClearButton projectId={projectId} />
        </div>
      </div>

      {pendingNotifyAt ? (
        <div className="flex items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            <span className="font-medium">Customer email queued.</span> They&rsquo;ll be notified
            shortly about the schedule changes.
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="bg-background"
            onClick={() => {
              startTransition(async () => {
                const res = await cancelScheduleNotifyAction(projectId);
                if (!res.ok) {
                  alert(`Could not cancel: ${res.error}`);
                  return;
                }
                router.refresh();
              });
            }}
          >
            Undo
          </Button>
        </div>
      ) : null}

      <ScheduleGantt
        tasks={visibleTasks}
        phases={phases}
        tradeTypicalPhase={tradeTypicalPhase}
        onTaskClick={setEditingTask}
        onTaskUpdate={handleTaskUpdate}
      />

      {editingTask ? (
        <ScheduleTaskEditor
          mode={{ kind: 'edit', task: editingTask }}
          open={true}
          onClose={() => setEditingTask(null)}
        />
      ) : null}

      {creating ? (
        <ScheduleTaskEditor
          mode={{ kind: 'create', projectId, defaultStartDate }}
          open={true}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}
