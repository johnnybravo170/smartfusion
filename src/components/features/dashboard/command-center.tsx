/**
 * Owner Command Center — Today / Blocked / Needs You + per-job task health.
 * Server component; no internal state. Renders empty states for the deferred
 * surfaces (schedule risks, invoice milestones, client decisions, Henry
 * suggestions) so the layout still reads correctly before those land.
 */

import { AlertTriangle, CalendarDays, CheckCircle2, ClipboardList, Hourglass } from 'lucide-react';
import Link from 'next/link';
import { TaskStatusBadge } from '@/components/features/tasks/task-status-badge';
import { VerifyTaskButtons } from '@/components/features/tasks/verify-task-buttons';
import type { DashboardTaskBuckets, JobTaskHealth, TaskRow } from '@/lib/db/queries/tasks';
import { cn } from '@/lib/utils';

type ChangeOrderRow = {
  id: string;
  job_id: string | null;
  total_cents: number;
  customer_name: string | null;
};

function TaskLine({ task }: { task: TaskRow }) {
  const href = task.job_id ? `/jobs/${task.job_id}/tasks` : '/todos';
  return (
    <li className="flex min-w-0 items-center justify-between gap-3 py-1.5 text-sm">
      <Link href={href} className="min-w-0 flex-1 truncate hover:underline">
        {task.title}
      </Link>
      <TaskStatusBadge status={task.status} className="shrink-0" hideLabelOnMobile />
      {task.due_date ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{task.due_date}</span>
      ) : null}
    </li>
  );
}

function Card({
  title,
  icon: Icon,
  count,
  empty,
  children,
}: {
  title: string;
  icon: typeof CalendarDays;
  count?: number;
  empty?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <header className="flex items-center justify-between pb-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        {typeof count === 'number' ? (
          <span className="text-xs text-muted-foreground">{count}</span>
        ) : null}
      </header>
      {count === 0 && empty ? (
        <p className="text-xs text-muted-foreground italic">{empty}</p>
      ) : (
        children
      )}
    </section>
  );
}

export function CommandCenter({
  buckets,
  jobHealth,
  changeOrdersPending,
  tasksToVerify = [],
}: {
  buckets: DashboardTaskBuckets;
  jobHealth: JobTaskHealth[];
  changeOrdersPending: ChangeOrderRow[];
  tasksToVerify?: TaskRow[];
}) {
  const today = buckets.dueToday;
  const overdue = buckets.overdue;
  const blockedAll = [
    ...buckets.blockedClient,
    ...buckets.blockedMaterial,
    ...buckets.blockedSub,
    ...buckets.blockedOther,
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Card
        title="Today"
        icon={CalendarDays}
        count={today.length + overdue.length}
        empty="Nothing on today."
      >
        {overdue.length > 0 ? (
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
              Overdue · {overdue.length}
            </p>
            <ul className="divide-y">
              {overdue.slice(0, 5).map((t) => (
                <TaskLine key={t.id} task={t} />
              ))}
            </ul>
          </div>
        ) : null}
        {today.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Due today
            </p>
            <ul className="divide-y">
              {today.map((t) => (
                <TaskLine key={t.id} task={t} />
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground italic">Schedule risks coming soon.</p>
      </Card>

      <Card title="Blocked" icon={Hourglass} count={blockedAll.length} empty="Nothing blocked.">
        <ul className="divide-y">
          {blockedAll.slice(0, 8).map((t) => (
            <TaskLine key={t.id} task={t} />
          ))}
        </ul>
      </Card>

      <Card
        title="Needs You"
        icon={AlertTriangle}
        count={changeOrdersPending.length + tasksToVerify.length}
        empty="Nothing waiting on you."
      >
        {tasksToVerify.length > 0 ? (
          <div className="mb-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              To verify · {tasksToVerify.length}
            </p>
            <ul className="divide-y">
              {tasksToVerify.slice(0, 6).map((t) => (
                <li
                  key={t.id}
                  className="flex min-w-0 items-center justify-between gap-3 py-1.5 text-sm"
                >
                  <Link
                    href={t.job_id ? `/jobs/${t.job_id}/tasks` : '/todos'}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {t.title}
                  </Link>
                  <VerifyTaskButtons taskId={t.id} compact />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {changeOrdersPending.length > 0 ? (
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Change orders · {changeOrdersPending.length}
            </p>
            <ul className="divide-y">
              {changeOrdersPending.slice(0, 6).map((co) => (
                <li
                  key={co.id}
                  className="flex min-w-0 items-center justify-between gap-3 py-1.5 text-sm"
                >
                  <Link
                    href={co.job_id ? `/jobs/${co.job_id}` : '#'}
                    className="min-w-0 flex-1 truncate hover:underline"
                  >
                    {co.customer_name ?? 'Change order'} ·{' '}
                    <span className="text-muted-foreground">
                      ${(co.total_cents / 100).toFixed(2)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground italic">
          Invoice milestones, client decisions, and Henry suggestions coming soon.
        </p>
      </Card>

      <section className="rounded-xl border bg-card p-4 md:col-span-3">
        <header className="flex items-center justify-between pb-2">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-4 text-muted-foreground" aria-hidden />
            <h3 className="text-sm font-semibold">Job task health</h3>
          </div>
          <span className="text-xs text-muted-foreground">{jobHealth.length}</span>
        </header>
        {jobHealth.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4" aria-hidden /> No open project tasks.
          </p>
        ) : (
          <ul className="grid gap-1 sm:grid-cols-2 md:grid-cols-3">
            {jobHealth.map((j) => (
              <li key={j.job_id}>
                <Link
                  href={`/jobs/${j.job_id}/tasks`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
                >
                  <span
                    title={j.health}
                    className={cn(
                      'inline-block size-2.5 shrink-0 rounded-full',
                      j.health === 'red' && 'bg-red-500',
                      j.health === 'yellow' && 'bg-amber-400',
                      j.health === 'green' && 'bg-emerald-500',
                    )}
                  >
                    <span className="sr-only">{j.health}</span>
                  </span>
                  <span className="flex-1 truncate">{j.customer_name ?? 'Job'}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{j.open_count}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

export function PersonalTasksCard({ tasks }: { tasks: TaskRow[] }) {
  return (
    <section className="rounded-xl border bg-card p-4">
      <header className="flex items-center justify-between pb-2">
        <h3 className="text-sm font-semibold">Your to-do</h3>
        <Link href="/todos" className="text-xs text-primary hover:underline">
          See all
        </Link>
      </header>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">Nothing on your personal list.</p>
      ) : (
        <ul className="divide-y">
          {tasks.map((t) => (
            <li key={t.id} className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.due_date ? (
                <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                  {t.due_date}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
