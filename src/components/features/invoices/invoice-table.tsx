'use client';

import { CheckCircle } from 'lucide-react';
import Link from 'next/link';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
import { RecordPaymentDialog } from '@/components/features/invoices/record-payment-dialog';
import { Button } from '@/components/ui/button';
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
import type { InvoiceWithCustomer } from '@/lib/db/queries/invoices';
import { invoiceTotalCents } from '@/lib/invoices/totals';
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
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => {
            const total = invoiceTotalCents(inv);
            return (
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
                  <span className="font-medium">{formatCad(total)}</span>
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
                <TableCell className="text-right">
                  {inv.status === 'sent' ? (
                    <RecordPaymentDialog
                      invoiceId={inv.id}
                      invoiceTotalCents={total}
                      trigger={
                        <Button variant="outline" size="sm">
                          <CheckCircle className="size-3.5" />
                          Mark paid
                        </Button>
                      }
                    />
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
