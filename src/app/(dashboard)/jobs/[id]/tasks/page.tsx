import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JobTabs } from '@/components/features/tasks/job-tabs';
import { ProjectTaskList } from '@/components/features/tasks/project-task-list';
import { TaskAddRow } from '@/components/features/tasks/task-add-row';
import { getCurrentUser } from '@/lib/auth/helpers';
import { listTasksForJob } from '@/lib/db/queries/tasks';
import { createClient } from '@/lib/supabase/server';

export default async function JobTasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: job } = await supabase
    .from('jobs')
    .select('id, customers:customer_id (name)')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!job) notFound();

  const [tasks, user] = await Promise.all([listTasksForJob(id), getCurrentUser()]);

  const customerRaw = (job as { customers: unknown }).customers;
  const customerObj = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
  const customerName =
    customerObj &&
    typeof customerObj === 'object' &&
    'name' in (customerObj as Record<string, unknown>)
      ? ((customerObj as { name: string }).name ?? 'Unknown customer')
      : 'Unknown customer';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to jobs
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{customerName}</h1>
        <p className="text-sm text-muted-foreground">Tasks</p>
      </header>

      <JobTabs jobId={id} current="tasks" />

      {tasks.length === 0 ? (
        <div className="rounded-md border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            No tasks yet. Add one below to start tracking work for this job.
          </p>
          <div className="mt-4">
            <TaskAddRow scope="project" jobId={id} placeholder="Add the first task…" />
          </div>
        </div>
      ) : (
        <ProjectTaskList jobId={id} tasks={tasks} currentUserId={user?.id ?? null} />
      )}
    </div>
  );
}
