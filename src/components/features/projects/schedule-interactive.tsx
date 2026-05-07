'use client';

/**
 * Interactive operator Gantt — wraps `<ScheduleGantt>` with click-to-
 * edit (modal opens with the clicked task's fields), an "+ Add task"
 * button (modal opens in create mode), and a "Clear & re-bootstrap"
 * escape hatch.
 *
 * State lives here so the page-level tab-server stays a pure server
 * component; this is the single client boundary for the v1 edit UX.
 * Drag-to-reschedule lands in a follow-up PR — when it does, the drag
 * handlers slot into `<ScheduleGantt>` alongside the click handler.
 */

import { useState } from 'react';
import { ScheduleClearButton } from '@/components/features/projects/schedule-clear-button';
import { ScheduleGantt } from '@/components/features/projects/schedule-gantt';
import { ScheduleTaskEditor } from '@/components/features/projects/schedule-task-editor';
import { Button } from '@/components/ui/button';
import type { ProjectScheduleTask } from '@/lib/db/queries/project-schedule';

export function ScheduleInteractive({
  projectId,
  tasks,
}: {
  projectId: string;
  tasks: ProjectScheduleTask[];
}) {
  const [editingTask, setEditingTask] = useState<ProjectScheduleTask | null>(null);
  const [creating, setCreating] = useState(false);

  // Default new tasks to the day after the last task ends, so the
  // operator's add-flow doesn't have to type a date for the common
  // "next thing in the sequence" case.
  const defaultStartDate = (() => {
    if (tasks.length === 0) return new Date().toISOString().slice(0, 10);
    const ends = tasks.map((t) => {
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
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'} · click any bar to edit
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setCreating(true)}>
            + Add task
          </Button>
          <ScheduleClearButton projectId={projectId} />
        </div>
      </div>

      <ScheduleGantt tasks={tasks} onTaskClick={setEditingTask} />

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
