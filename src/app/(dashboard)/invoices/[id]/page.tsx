import { ArrowLeft, Briefcase, User } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InvoiceActions } from '@/components/features/invoices/invoice-actions';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime } from '@/lib/date/format';
import { getInvoice } from '@/lib/db/queries/invoices';
import { createClient } from '@/lib/supabase/server';
import type { InvoiceStatus } from '@/lib/validators/invoice';

function formatCad(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function shortId(id: string) {
  return id.slice(0, 8);
}

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [invoice, tenant] = await Promise.all([getInvoice(id), getCurrentTenant()]);
  if (!invoice) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';
  const formatTimestamp = (iso: string | null | undefined) =>
    iso ? formatDateTime(iso, { timezone: tz }) : '';

  // Load worklog entries for this invoice's job.
  const supabase = await createClient();
  const { data: worklog } = await supabase
    .from('worklog_entries')
    .select('id, entry_type, title, body, created_at')
    .eq('related_type', 'job')
    .eq('related_id', invoice.job_id)
    .ilike('title', '%invoice%')
    .order('created_at', { ascending: false });

  const totalCents = invoice.amount_cents + invoice.tax_cents;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/invoices"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to invoices
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              Invoice #{shortId(invoice.id)}
            </h1>
            <InvoiceStatusBadge status={invoice.status as InvoiceStatus} />
          </div>
          <p className="text-sm text-muted-foreground">
            Created {formatTimestamp(invoice.created_at)}
          </p>
        </div>
      </header>

      {/* Amount breakdown */}
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Subtotal</span>
            <span>{formatCad(invoice.amount_cents)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">GST (5%)</span>
            <span>{formatCad(invoice.tax_cents)}</span>
          </div>
          <div className="border-t pt-2">
            <div className="flex items-center justify-between text-base font-semibold">
              <span>Total</span>
              <span>{formatCad(totalCents)}</span>
            </div>
          </div>
        </div>
      </section>

      {/* Customer + Job links */}
      <section className="grid gap-4 md:grid-cols-2">
        {invoice.customer && (
          <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
            <User className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Customer
              </span>
              <p className="text-sm font-medium">
                <Link
                  href={`/customers/${invoice.customer.id}`}
                  className="hover:text-primary hover:underline"
                >
                  {invoice.customer.name}
                </Link>
              </p>
            </div>
          </div>
        )}
        {invoice.job && (
          <div className="flex items-start gap-3 rounded-xl border bg-card p-4">
            <Briefcase className="mt-0.5 size-4 text-muted-foreground" />
            <div>
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Job</span>
              <p className="text-sm font-medium">
                <Link
                  href={`/jobs/${invoice.job.id}`}
                  className="hover:text-primary hover:underline"
                >
                  #{shortId(invoice.job.id)}
                </Link>
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Status-specific info */}
      {invoice.status === 'paid' && invoice.paid_at && (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
          <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
            Paid on {formatTimestamp(invoice.paid_at)}
          </p>
        </section>
      )}

      {invoice.status === 'void' && (
        <section className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
          <p className="text-sm font-medium text-destructive">This invoice has been voided.</p>
        </section>
      )}

      {invoice.sent_at && invoice.status === 'sent' && (
        <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
          <p className="text-sm text-amber-800 dark:text-amber-200">
            Sent on {formatTimestamp(invoice.sent_at)}. Awaiting payment.
          </p>
        </section>
      )}

      {/* Actions */}
      <InvoiceActions
        invoiceId={invoice.id}
        status={invoice.status as InvoiceStatus}
        paymentUrl={invoice.pdf_url}
      />

      {/* Invoice-related worklog */}
      {worklog && worklog.length > 0 && (
        <section className="rounded-xl border bg-card p-5">
          <header className="pb-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              History
            </h2>
          </header>
          <ol className="relative ml-2 space-y-3 border-l border-muted pl-4">
            {worklog.map((entry) => (
              <li key={entry.id} className="text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{entry.title ?? 'Entry'}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatTimestamp(entry.created_at)}
                  </span>
                </div>
                {entry.body ? (
                  <p className="mt-1 text-sm text-muted-foreground">{entry.body}</p>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
