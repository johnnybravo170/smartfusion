import Link from 'next/link';
import { JobStatusBadge } from '@/components/features/jobs/job-status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDateTime } from '@/lib/date/format';
import type { TodaysJob } from '@/lib/db/queries/dashboard';
import type { JobStatus } from '@/lib/validators/job';

export function TodaysJobs({ jobs, timezone }: { jobs: TodaysJob[]; timezone: string }) {
  if (jobs.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Today&apos;s Jobs</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No jobs scheduled for today. Enjoy the day off.{' '}
            <Link href="/jobs/new" className="text-primary underline underline-offset-4">
              Schedule one
            </Link>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Today&apos;s Jobs</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="flex items-start justify-between gap-4 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                {job.customer ? (
                  <Link
                    href={`/customers/${job.customer.id}`}
                    className="font-medium text-sm hover:underline truncate"
                  >
                    {job.customer.name}
                  </Link>
                ) : (
                  <span className="text-sm text-muted-foreground">No customer</span>
                )}
                <JobStatusBadge status={job.status as JobStatus} />
              </div>
              {job.customer?.address_line1 && (
                <p className="text-xs text-muted-foreground truncate">
                  {job.customer.address_line1}
                  {job.customer.city ? `, ${job.customer.city}` : ''}
                </p>
              )}
            </div>
            <div className="shrink-0 text-right">
              <p className="text-xs text-muted-foreground">
                {formatDateTime(job.scheduled_at, {
                  timezone,
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </p>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
