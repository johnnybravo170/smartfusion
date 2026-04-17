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
import { formatDate } from '@/lib/date/format';
import type { QuoteWithCustomer } from '@/lib/db/queries/quotes';
import { formatCurrency } from '@/lib/pricing/calculator';
import type { QuoteStatus } from '@/lib/validators/quote';
import { QuoteStatusBadge } from './quote-status-badge';

export function QuoteTable({ quotes }: { quotes: QuoteWithCustomer[] }) {
  const timezone = useTenantTimezone();
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="text-right">Total</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotes.map((q) => (
            <TableRow key={q.id} className="cursor-pointer transition-colors hover:bg-muted/50">
              <TableCell className="font-medium">
                <Link href={`/quotes/${q.id}`} className="text-foreground hover:underline">
                  {q.customer?.name ?? 'Unknown customer'}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatCurrency(q.total_cents)}
              </TableCell>
              <TableCell>
                <QuoteStatusBadge status={q.status as QuoteStatus} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(q.sent_at, { timezone })}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(q.created_at, { timezone })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
