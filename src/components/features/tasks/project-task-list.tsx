'use client';

/**
 * Project task list. Groups by phase using the renovation default phase
 * order; tasks with no phase render in an "Unassigned phase" group at the
 * bottom. Filter chips at the top reduce the displayed set.
 *
 * Rename / add phase + drag-between-phases is deferred to v2 per spec.
 */

import { useMemo, useState } from 'react';
import type { TaskRow as TaskRowData } from '@/lib/db/queries/tasks';
import { defaultRenovationPhases } from '@/lib/validators/task';
import { TaskAddRow } from './task-add-row';
import { type TaskFilter, TaskFilters } from './task-filters';
import { TaskRow } from './task-row';

const blockedStatuses = new Set(['waiting_client', 'waiting_material', 'waiting_sub', 'blocked']);

function inThisWeek(due: string | null): boolean {
  if (!due) return false;
  const today = new Date();
  const start = today.toISOString().slice(0, 10);
  const end = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return due >= start && due <= end;
}

export function ProjectTaskList({
  jobId,
  tasks,
  currentUserId,
  isOwner = false,
}: {
  jobId: string;
  tasks: TaskRowData[];
  currentUserId: string | null;
  isOwner?: boolean;
}) {
  const [filter, setFilter] = useState<TaskFilter>('all');

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      switch (filter) {
        case 'mine':
          return currentUserId && t.assignee_id === currentUserId;
        case 'unassigned':
          return !t.assignee_id;
        case 'blocked':
          return blockedStatuses.has(t.status);
        case 'due_week':
          return inThisWeek(t.due_date);
        default:
          return true;
      }
    });
  }, [tasks, filter, currentUserId]);

  const groups = useMemo(() => {
    const map = new Map<string, TaskRowData[]>();
    for (const phase of defaultRenovationPhases) map.set(phase, []);
    map.set('Other', []);
    for (const t of filtered) {
      const key = t.phase && map.has(t.phase) ? t.phase : t.phase || 'Other';
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(t);
    }
    return map;
  }, [filtered]);

  return (
    <div className="flex flex-col gap-4">
      <TaskFilters current={filter} onChange={setFilter} />

      <div className="flex flex-col gap-5">
        {Array.from(groups.entries()).map(([phase, items]) => (
          <section key={phase} className="flex flex-col gap-2">
            <header className="flex items-center justify-between">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {phase}
              </h3>
              <span className="text-xs text-muted-foreground">{items.length}</span>
            </header>
            {items.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No tasks in this phase yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {items.map((t) => (
                  <TaskRow key={t.id} task={t} isOwner={isOwner} />
                ))}
              </div>
            )}
            {filter === 'all' ? (
              <TaskAddRow
                scope="project"
                jobId={jobId}
                phase={phase}
                placeholder={`Add to ${phase}…`}
              />
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
