'use client';

import { Download, ExternalLink, Receipt } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { type InvoiceRow, listInvoicesAction } from '@/server/actions/billing-management';

const PAGE_SIZE = 12;

export function InvoicesTable() {
  const tz = useTenantTimezone();
  const [rows, setRows] = useState<InvoiceRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    startTransition(async () => {
      const r = await listInvoicesAction({ limit: PAGE_SIZE });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRows(r.invoices);
      setHasMore(r.hasMore);
      setCursor(r.nextCursor);
      setLoaded(true);
    });
  }, []);

  function loadMore() {
    if (!cursor) return;
    startTransition(async () => {
      const r = await listInvoicesAction({ limit: PAGE_SIZE, cursor });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      setRows((prev) => [...prev, ...r.invoices]);
      setHasMore(r.hasMore);
      setCursor(r.nextCursor);
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start gap-2">
          <Receipt className="size-5 mt-0.5" />
          <div>
            <CardTitle>Invoice history</CardTitle>
            <CardDescription>Receipts for every charge, including GST.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {!loaded && pending ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">GST</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Receipt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell>{formatDate(inv.createdIso, tz)}</TableCell>
                    <TableCell className="text-right">
                      {formatCents(inv.amountPaidCents || inv.amountDueCents, inv.currency)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {inv.taxCents > 0 ? formatCents(inv.taxCents, inv.currency) : '—'}
                    </TableCell>
                    <TableCell className="capitalize">{inv.status.replace('_', ' ')}</TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        {inv.hostedUrl ? (
                          <Button asChild variant="ghost" size="sm">
                            <a
                              href={inv.hostedUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="View invoice"
                            >
                              <ExternalLink className="size-4" />
                            </a>
                          </Button>
                        ) : null}
                        {inv.pdfUrl ? (
                          <Button asChild variant="ghost" size="sm">
                            <a
                              href={inv.pdfUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label="Download PDF"
                            >
                              <Download className="size-4" />
                            </a>
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {hasMore ? (
              <div className="mt-3 flex justify-center">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={pending}
                >
                  {pending ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function formatCents(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}
