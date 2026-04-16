import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { JobWithCustomer } from '@/lib/db/queries/jobs';
import { JobStatusBadge } from './job-status-badge';

const dateTimeFormatter = new Intl.DateTimeFormat('en-CA', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const dateFormatter = new Intl.DateTimeFormat('en-CA', { dateStyle: 'medium' });

function truncate(value: string, max = 60) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function notesPreview(notes: string | null): string {
  if (!notes) return '—';
  const firstLine = notes.split('\n')[0] ?? '';
  return truncate(firstLine.trim(), 70) || '—';
}

/**
 * Server-rendered job list. Rows link to the detail page. Mirrors the
 * Customers table pattern so the look-and-feel is consistent.
 */
export function JobListTable({ jobs }: { jobs: JobWithCustomer[] }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="w-[180px]">Scheduled</TableHead>
            <TableHead className="w-[140px]">Status</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead className="w-[140px]">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job) => (
            <TableRow key={job.id} className="cursor-pointer transition-colors hover:bg-muted/50">
              <TableCell className="font-medium">
                <Link href={`/jobs/${job.id}`} className="text-foreground hover:underline">
                  {job.customer?.name ?? 'Unknown customer'}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {job.scheduled_at ? dateTimeFormatter.format(new Date(job.scheduled_at)) : '—'}
              </TableCell>
              <TableCell>
                <JobStatusBadge status={job.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{notesPreview(job.notes)}</TableCell>
              <TableCell className="text-muted-foreground">
                {dateFormatter.format(new Date(job.created_at))}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
