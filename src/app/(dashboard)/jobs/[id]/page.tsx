import {
  CalendarClock,
  Camera,
  ClipboardList,
  Copy,
  FileText,
  Pencil,
  Receipt,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChangeOrderList } from '@/components/features/change-orders/change-order-list';
import { GenerateInvoiceButton } from '@/components/features/invoices/generate-invoice-button';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
import { DeleteJobButton } from '@/components/features/jobs/delete-job-button';
import { InlineScheduler } from '@/components/features/jobs/inline-scheduler';
import { JobStatusBadge } from '@/components/features/jobs/job-status-badge';
import { JobStatusSelect } from '@/components/features/jobs/job-status-select';
import { UpdateClientButton } from '@/components/features/jobs/update-client-button';
import { PhotoGallery } from '@/components/features/photos/photo-gallery';
import { PhotoUpload } from '@/components/features/photos/photo-upload';
import { QuoteStatusBadge } from '@/components/features/quotes/quote-status-badge';
import { SocialPostSection } from '@/components/features/social/social-post-section';
import { JobTabs } from '@/components/features/tasks/job-tabs';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime, formatRelativeTime } from '@/lib/date/format';
import { listChangeOrders } from '@/lib/db/queries/change-orders';
import { getJob, listWorklogForJob } from '@/lib/db/queries/jobs';
import { countPhotosByJob } from '@/lib/db/queries/photos';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import type { QuoteStatus } from '@/lib/validators/quote';
import { duplicateJobAction, rescheduleJobAction } from '@/server/actions/jobs';

function shortId(id: string) {
  return id.slice(0, 8);
}

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [job, tenant] = await Promise.all([getJob(id), getCurrentTenant()]);
  if (!job) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';
  const formatTimestamp = (iso: string | null | undefined): string =>
    iso ? formatDateTime(iso, { timezone: tz }) : '\u2014';

  const [worklog, changeOrders, photoCount] = await Promise.all([
    listWorklogForJob(id),
    listChangeOrders({ jobId: id }),
    countPhotosByJob(id),
  ]);

  const customerName = job.customer?.name ?? 'Unknown customer';

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <DetailPageNav homeHref="/jobs" homeLabel="All jobs" />

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {job.customer ? (
                <Link
                  href={`/contacts/${job.customer.id}`}
                  className="hover:text-primary hover:underline"
                >
                  {customerName}
                </Link>
              ) : (
                customerName
              )}
            </h1>
            <JobStatusBadge status={job.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Job <span className="font-mono">#{shortId(job.id)}</span> · Added{' '}
            {formatTimestamp(job.created_at)}
          </p>
        </div>
        <div className="flex items-start gap-4">
          <JobStatusSelect
            jobId={job.id}
            currentStatus={job.status}
            hasPhotos={photoCount > 0}
            customerName={customerName}
            quoteTotalCents={job.quote?.total_cents ?? null}
            hasInvoice={(job.invoices ?? []).length > 0}
          />
          <div className="flex items-center gap-2">
            <UpdateClientButton jobId={job.id} />
            <Button asChild variant="outline" size="sm">
              <Link href={`/jobs/${job.id}/edit`}>
                <Pencil className="size-3.5" />
                Edit
              </Link>
            </Button>
            <DuplicateJobButton jobId={job.id} />
            <DeleteJobButton jobId={job.id} customerName={customerName} />
          </div>
        </div>
      </header>

      <JobTabs jobId={job.id} current="overview" />

      <section className="grid gap-4 rounded-xl border bg-card p-5 md:grid-cols-3">
        <InlineScheduler
          jobId={job.id}
          scheduledAt={job.scheduled_at}
          timezone={tz}
          action={rescheduleJobAction}
        />
        <TimestampBlock icon={CalendarClock} label="Started" value={job.started_at} timezone={tz} />
        <TimestampBlock
          icon={CalendarClock}
          label="Completed"
          value={job.completed_at}
          timezone={tz}
        />
      </section>

      {job.quote ? (
        <Link href={`/quotes/${job.quote.id}`} className="block">
          <section className="flex items-center justify-between rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50">
            <div className="flex items-center gap-3">
              <FileText className="size-4 text-muted-foreground" aria-hidden />
              <div className="flex flex-col">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Linked quote
                </span>
                <span className="font-mono text-sm">#{shortId(job.quote.id)}</span>
              </div>
            </div>
            <QuoteStatusBadge status={job.quote.status as QuoteStatus} />
          </section>
        </Link>
      ) : null}

      <section className="rounded-xl border bg-card p-4">
        <header className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Receipt className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Invoices
            </h2>
          </div>
          {job.status === 'complete' && job.invoices.length === 0 && (
            <GenerateInvoiceButton jobId={job.id} />
          )}
        </header>
        {job.invoices.length > 0 ? (
          <ul className="divide-y">
            {job.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <Link
                    href={`/invoices/${inv.id}`}
                    className="font-mono text-xs text-muted-foreground hover:text-primary hover:underline"
                  >
                    #{shortId(inv.id)}
                  </Link>
                  <InvoiceStatusBadge status={inv.status as InvoiceStatus} />
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(inv.created_at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {job.status === 'complete'
              ? 'No invoices yet. Generate one above.'
              : 'Complete this job to generate an invoice.'}
          </p>
        )}
      </section>

      {job.notes ? (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {job.notes}
          </p>
        </section>
      ) : null}

      <section className="rounded-xl border bg-card p-4">
        <header className="flex items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <ClipboardList className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Change Orders
            </h2>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href={`/jobs/${job.id}/change-orders/new`}>New Change Order</Link>
          </Button>
        </header>
        <ChangeOrderList changeOrders={changeOrders} jobId={job.id} />
      </section>

      <section className="rounded-xl border bg-card p-5">
        <header className="flex items-center gap-2 pb-3">
          <Camera className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Photos
          </h2>
        </header>
        <p className="mb-4 text-xs text-muted-foreground">
          Before, after, and progress photos for this job.
        </p>
        <div className="space-y-4">
          <PhotoUpload jobId={job.id} />
          <PhotoGallery jobId={job.id} />
        </div>
      </section>

      {job.status === 'complete' && tenant && (
        <SocialPostSection jobId={job.id} businessName={tenant.name} />
      )}

      <section className="rounded-xl border bg-card p-5">
        <header className="flex items-center justify-between pb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Status history
          </h2>
          <span className="text-xs text-muted-foreground">{worklog.length}</span>
        </header>
        {worklog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No status changes yet. Move this job on the board and you'll see the history here.
          </p>
        ) : (
          <ol className="relative ml-2 space-y-3 border-l border-muted pl-4">
            {worklog.map((entry) => (
              <li key={entry.id} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.title ?? 'Entry'}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(entry.created_at, { timezone: tz })}
                  </span>
                </div>
                {entry.body ? (
                  <p className="mt-1 text-sm text-muted-foreground">{entry.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function DuplicateJobButton({ jobId }: { jobId: string }) {
  async function action() {
    'use server';
    const result = await duplicateJobAction({ jobId });
    if (!result.ok) throw new Error(result.error);
    const { redirect } = await import('next/navigation');
    redirect(`/jobs/${result.id}`);
  }

  return (
    <form action={action}>
      <Button type="submit" variant="outline" size="sm">
        <Copy className="size-3.5" />
        Duplicate
      </Button>
    </form>
  );
}

function TimestampBlock({
  icon: Icon,
  label,
  value,
  timezone,
}: {
  icon: typeof CalendarClock;
  label: string;
  value: string | null | undefined;
  timezone: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm text-foreground">
          {value ? formatDateTime(value, { timezone }) : '\u2014'}
        </span>
      </div>
    </div>
  );
}
