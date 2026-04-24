import { WorkerTaskList } from '@/components/features/worker/worker-task-list';
import { requireWorker } from '@/lib/auth/helpers';
import { listWorkerTasks } from '@/lib/db/queries/tasks';

export const dynamic = 'force-dynamic';

export default async function WorkerTasksPage() {
  const { user } = await requireWorker();
  const tasks = await listWorkerTasks(user.id);

  return (
    <div className="flex flex-col gap-3">
      <header>
        <h1 className="text-xl font-semibold">My tasks</h1>
        <p className="text-sm text-muted-foreground">
          {tasks.length === 0
            ? "You don't have any assigned tasks yet."
            : `${tasks.length} open ${tasks.length === 1 ? 'task' : 'tasks'}`}
        </p>
      </header>

      {tasks.length === 0 ? (
        <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
          Nothing assigned. When your PM assigns work you&apos;ll see it here.
        </div>
      ) : (
        <WorkerTaskList tasks={tasks} />
      )}
    </div>
  );
}
