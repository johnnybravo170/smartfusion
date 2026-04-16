import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { JobForm } from '@/components/features/jobs/job-form';
import { listCustomers } from '@/lib/db/queries/customers';
import { getJob } from '@/lib/db/queries/jobs';
import type { JobInput, JobStatus } from '@/lib/validators/job';
import { type JobActionResult, updateJobAction } from '@/server/actions/jobs';

export const metadata = {
  title: 'Edit job — Smartfusion',
};

/**
 * Convert a UTC ISO timestamp back into the local-wall-clock string that
 * `<input type="datetime-local">` accepts (`YYYY-MM-DDTHH:mm`).
 */
function toDatetimeLocal(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default async function EditJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [job, customers] = await Promise.all([getJob(id), listCustomers({ limit: 500 })]);
  if (!job) notFound();

  const defaults: JobInput & { id: string } = {
    id: job.id,
    customer_id: job.customer_id ?? '',
    quote_id: job.quote_id ?? '',
    status: job.status as JobStatus,
    scheduled_at: toDatetimeLocal(job.scheduled_at),
    notes: job.notes ?? '',
  };

  async function action(input: JobInput & { id?: string }): Promise<JobActionResult> {
    'use server';
    return updateJobAction({ ...input, id });
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/jobs/${job.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to job
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit job</h1>
        <p className="text-sm text-muted-foreground">
          Change the scheduled time, swap customer, or update notes.
        </p>
      </header>

      <JobForm
        mode="edit"
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        defaults={defaults}
        action={action}
        cancelHref={`/jobs/${job.id}`}
      />
    </div>
  );
}
