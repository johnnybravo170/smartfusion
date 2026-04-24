import { CheckCircle2 } from 'lucide-react';
import { TaskAddRow } from '@/components/features/tasks/task-add-row';
import { TaskRow } from '@/components/features/tasks/task-row';
import { requireTenant } from '@/lib/auth/helpers';
import { listPersonalTasks } from '@/lib/db/queries/tasks';

/**
 * Owner's personal to-do list. Flat list, no phases. Completed tasks
 * disappear after 24h via the listPersonalTasks server-side filter.
 */
export default async function TodosPage() {
  const { user } = await requireTenant();
  const tasks = await listPersonalTasks(user.id);

  const open = tasks.filter((t) => t.status !== 'done');
  const recentlyDone = tasks.filter((t) => t.status === 'done');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">To-do</h1>
        <p className="text-sm text-muted-foreground">
          Personal list. Completed items hide after 24 hours.
        </p>
      </header>

      <TaskAddRow scope="personal" placeholder="Add a to-do…" />

      <section className="flex flex-col gap-2">
        {open.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed py-10 text-center">
            <CheckCircle2 className="size-6 text-muted-foreground" aria-hidden />
            <p className="text-sm text-muted-foreground">All clear.</p>
          </div>
        ) : (
          open.map((t) => <TaskRow key={t.id} task={t} showCheckbox />)
        )}
      </section>

      {recentlyDone.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recently done
          </h2>
          {recentlyDone.map((t) => (
            <TaskRow key={t.id} task={t} showCheckbox />
          ))}
        </section>
      ) : null}
    </div>
  );
}
