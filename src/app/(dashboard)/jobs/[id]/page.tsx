import { ArrowLeft, CalendarClock, Camera, FileText, Pencil, Receipt } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { GenerateInvoiceButton } from '@/components/features/invoices/generate-invoice-button';
import { DeleteJobButton } from '@/components/features/jobs/delete-job-button';
import { JobStatusBadge } from '@/components/features/jobs/job-status-badge';
import { JobStatusSelect } from '@/components/features/jobs/job-status-select';
import { PhotoGallery } from '@/components/features/photos/photo-gallery';
import { PhotoUpload } from '@/components/features/photos/photo-upload';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime, formatRelativeTime } from '@/lib/date/format';
import { getJob, listWorklogForJob } from '@/lib/db/queries/jobs';

function shortId(id: string) {
  return id.slice(0, 8);
}

const QUOTE_STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-blue-100 text-blue-800',
  accepted: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-destructive/10 text-destructive',
  expired: 'bg-muted text-muted-foreground',
};

const INVOICE_STATUS_CLASS: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-blue-100 text-blue-800',
  paid: 'bg-emerald-100 text-emerald-800',
  void: 'bg-destructive/10 text-destructive',
};

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [job, tenant] = await Promise.all([getJob(id), getCurrentTenant()]);
  if (!job) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';
  const formatTimestamp = (iso: string | null | undefined): string =>
    iso ? formatDateTime(iso, { timezone: tz }) : '\u2014';

  const worklog = await listWorklogForJob(id);

  const customerName = job.customer?.name ?? 'Unknown customer';

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

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {job.customer ? (
                <Link
                  href={`/customers/${job.customer.id}`}
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
          <JobStatusSelect jobId={job.id} currentStatus={job.status} />
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/jobs/${job.id}/edit`}>
                <Pencil className="size-3.5" />
                Edit
              </Link>
            </Button>
            <DeleteJobButton jobId={job.id} customerName={customerName} />
          </div>
        </div>
      </header>

      <section className="grid gap-4 rounded-xl border bg-card p-5 md:grid-cols-3">
        <TimestampBlock
          icon={CalendarClock}
          label="Scheduled"
          value={job.scheduled_at}
          timezone={tz}
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
        <section className="flex items-center justify-between rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <FileText className="size-4 text-muted-foreground" aria-hidden />
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Linked quote
              </span>
              <span className="font-mono text-sm">#{shortId(job.quote.id)}</span>
            </div>
          </div>
          <Badge
            variant="secondary"
            className={`font-medium ${QUOTE_STATUS_CLASS[job.quote.status] ?? 'bg-muted'}`}
          >
            {job.quote.status}
          </Badge>
        </section>
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
                  <Badge
                    variant="secondary"
                    className={`font-medium ${INVOICE_STATUS_CLASS[inv.status] ?? 'bg-muted'}`}
                  >
                    {inv.status}
                  </Badge>
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
