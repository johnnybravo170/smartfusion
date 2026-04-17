'use client';

import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { formatDate, formatDateTime } from '@/lib/date/format';
import type { JobWithCustomer } from '@/lib/db/queries/jobs';
import { JobStatusBadge } from './job-status-badge';

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
  const timezone = useTenantTimezone();
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
                {job.scheduled_at ? formatDateTime(job.scheduled_at, { timezone }) : '\u2014'}
              </TableCell>
              <TableCell>
                <JobStatusBadge status={job.status} />
              </TableCell>
              <TableCell className="text-muted-foreground">{notesPreview(job.notes)}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(job.created_at, { timezone })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
