'use client';

import Link from 'next/link';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
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
import { type InvoiceWithCustomer, invoiceTotalCents } from '@/lib/db/queries/invoices';
import type { InvoiceStatus } from '@/lib/validators/invoice';

function formatCad(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function InvoiceTable({ invoices }: { invoices: InvoiceWithCustomer[] }) {
  const timezone = useTenantTimezone();
  return (
    <div className="rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="text-right">Amount</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Sent</TableHead>
            <TableHead>Paid</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => (
            <TableRow key={inv.id}>
              <TableCell>
                <Link
                  href={`/invoices/${inv.id}`}
                  className="font-medium hover:text-primary hover:underline"
                >
                  {inv.customer?.name ?? 'Unknown'}
                </Link>
                <p className="font-mono text-xs text-muted-foreground">#{inv.id.slice(0, 8)}</p>
              </TableCell>
              <TableCell className="text-right">
                <span className="font-medium">{formatCad(invoiceTotalCents(inv))}</span>
                <p className="text-xs text-muted-foreground">
                  {inv.tax_inclusive
                    ? `incl. ${formatCad(inv.tax_cents)} GST`
                    : `${formatCad(inv.amount_cents)} + ${formatCad(inv.tax_cents)} GST`}
                </p>
              </TableCell>
              <TableCell>
                <InvoiceStatusBadge status={inv.status as InvoiceStatus} />
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(inv.sent_at, { timezone })}
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {formatDate(inv.paid_at, { timezone })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
