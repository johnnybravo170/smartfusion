import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { JobForm } from '@/components/features/jobs/job-form';
import { listCustomers } from '@/lib/db/queries/customers';
import type { JobInput } from '@/lib/validators/job';
import { createJobAction } from '@/server/actions/jobs';

type RawSearchParams = Record<string, string | string[] | undefined>;

export const metadata = {
  title: 'New job — Smartfusion',
};

function parseCustomerId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export default async function NewJobPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const prefilledCustomerId = parseCustomerId(resolvedSearchParams.customer_id);

  const customers = await listCustomers({ limit: 500 });

  const defaults: Partial<JobInput> = {
    status: 'booked',
    ...(prefilledCustomerId ? { customer_id: prefilledCustomerId } : {}),
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/jobs"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to jobs
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Schedule a job</h1>
        <p className="text-sm text-muted-foreground">
          Jobs track the work once a quote is accepted (or you book something direct).
        </p>
      </header>

      {customers.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-6 text-sm">
          <p className="font-medium">You need a customer first.</p>
          <p className="mt-1 text-muted-foreground">
            Jobs are always tied to a customer.{' '}
            <Link href="/customers/new" className="text-foreground underline">
              Add one
            </Link>{' '}
            and come back.
          </p>
        </div>
      ) : (
        <JobForm
          mode="create"
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
          defaults={defaults}
          action={createJobAction}
          cancelHref="/jobs"
        />
      )}
    </div>
  );
}
