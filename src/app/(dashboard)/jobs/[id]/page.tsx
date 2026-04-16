import { ArrowLeft, CalendarClock, Camera, FileText, Pencil, Receipt } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DeleteJobButton } from '@/components/features/jobs/delete-job-button';
import { JobStatusBadge } from '@/components/features/jobs/job-status-badge';
import { JobStatusSelect } from '@/components/features/jobs/job-status-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getJob, listWorklogForJob } from '@/lib/db/queries/jobs';

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateTimeFormatter.format(new Date(iso));
}

function shortId(id: string) {
  return id.slice(0, 8);
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffMs = Date.now() - then;
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return dateTimeFormatter.format(new Date(iso));
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

  const job = await getJob(id);
  if (!job) notFound();

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
        <TimestampBlock icon={CalendarClock} label="Scheduled" value={job.scheduled_at} />
        <TimestampBlock icon={CalendarClock} label="Started" value={job.started_at} />
        <TimestampBlock icon={CalendarClock} label="Completed" value={job.completed_at} />
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

      {job.invoices.length > 0 ? (
        <section className="rounded-xl border bg-card p-4">
          <header className="flex items-center gap-2 pb-3">
            <Receipt className="size-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Invoices
            </h2>
          </header>
          <ul className="divide-y">
            {job.invoices.map((inv) => (
              <li key={inv.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    #{shortId(inv.id)}
                  </span>
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
        </section>
      ) : null}

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
        <p className="text-sm text-muted-foreground">
          Photo uploads coming in Phase 1C integration.
        </p>
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
                    {relativeTime(entry.created_at)}
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
}: {
  icon: typeof CalendarClock;
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm text-foreground">{formatTimestamp(value)}</span>
      </div>
    </div>
  );
}
