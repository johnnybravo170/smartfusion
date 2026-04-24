/**
 * Tasks panel on the lead detail page. Mirrors the project task list
 * but pins scope='lead' and the lead_id — no phases, no job. Reuses
 * `<TaskRow />` so the status pill / inline edit / filter behaviour
 * stays consistent with the project list per PATTERNS.md §10.
 *
 * When the lead is later converted (a job is created for this
 * customer), `workerChangeTaskStatusAction`'s sibling `migrateLeadTasks`
 * helper is called from `createJobAction` and these rows flip to
 * scope='project' with the new job_id.
 */

import type { TaskRow as TaskRowData } from '@/lib/db/queries/tasks';
import { TaskAddRow } from './task-add-row';
import { TaskRow } from './task-row';

export function LeadTasksSection({
  leadId,
  tasks,
  isOwner,
}: {
  leadId: string;
  tasks: TaskRowData[];
  isOwner: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <header className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Tasks</h2>
        <span className="text-xs text-muted-foreground">{tasks.length}</span>
      </header>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">
          No tasks yet. Anything you add now will move to the project once you start one.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {tasks.map((t) => (
            <TaskRow key={t.id} task={t} isOwner={isOwner} />
          ))}
        </div>
      )}
      <TaskAddRow scope="lead" leadId={leadId} placeholder="Add a follow-up…" />
    </section>
  );
}
