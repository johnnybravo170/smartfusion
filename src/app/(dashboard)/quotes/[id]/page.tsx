import { ArrowLeft, FileText, Pencil } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AcceptQuoteButton,
  ConvertToJobButton,
  DeleteQuoteButton,
  DownloadPdfButton,
  RejectQuoteButton,
  SendQuoteButton,
} from '@/components/features/quotes/quote-actions';
import { QuoteStatusBadge } from '@/components/features/quotes/quote-status-badge';
import { SurfaceList } from '@/components/features/quotes/surface-list';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime, formatRelativeTime } from '@/lib/date/format';
import { getQuote, listWorklogForQuote } from '@/lib/db/queries/quotes';
import type { QuoteStatus } from '@/lib/validators/quote';

function shortId(id: string) {
  return id.slice(0, 8);
}

export default async function QuoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [quote, tenant] = await Promise.all([getQuote(id), getCurrentTenant()]);
  if (!quote) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';

  const worklog = await listWorklogForQuote(id);

  const customerName = quote.customer?.name ?? 'Unknown customer';
  const status = quote.status as QuoteStatus;

  const surfaceEntries = quote.surfaces.map((s) => ({
    id: s.id,
    surface_type: s.surface_type,
    label: s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
    sqft: s.sqft,
    price_cents: s.price_cents,
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/quotes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to quotes
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {quote.customer ? (
                <Link
                  href={`/customers/${quote.customer.id}`}
                  className="hover:text-primary hover:underline"
                >
                  {customerName}
                </Link>
              ) : (
                customerName
              )}
            </h1>
            <QuoteStatusBadge status={status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Quote <span className="font-mono">#{shortId(quote.id)}</span> · Created{' '}
            {formatDateTime(quote.created_at, { timezone: tz })}
            {quote.sent_at ? ` · Sent ${formatDateTime(quote.sent_at, { timezone: tz })}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Status-dependent actions */}
          {status === 'draft' && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link href={`/quotes/${quote.id}/edit`}>
                  <Pencil className="size-3.5" />
                  Edit
                </Link>
              </Button>
              <SendQuoteButton quoteId={quote.id} />
              <DeleteQuoteButton quoteId={quote.id} customerName={customerName} />
            </>
          )}
          {status === 'sent' && (
            <>
              <AcceptQuoteButton quoteId={quote.id} />
              <RejectQuoteButton quoteId={quote.id} />
              <Button asChild variant="outline" size="sm">
                <Link href={`/quotes/${quote.id}/edit`}>
                  <Pencil className="size-3.5" />
                  Edit
                </Link>
              </Button>
              {quote.pdf_url && <DownloadPdfButton pdfUrl={quote.pdf_url} />}
            </>
          )}
          {status === 'accepted' && (
            <>
              <ConvertToJobButton quoteId={quote.id} />
              {quote.pdf_url && <DownloadPdfButton pdfUrl={quote.pdf_url} />}
            </>
          )}
          {status === 'rejected' && (
            <Button asChild variant="outline" size="sm">
              <Link href={`/quotes/new?customer_id=${quote.customer_id}`}>Clone as new quote</Link>
            </Button>
          )}
        </div>
      </header>

      {/* Surface breakdown */}
      <section>
        <div className="mb-3 flex items-center gap-2">
          <FileText className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Surfaces
          </h2>
        </div>
        <SurfaceList
          surfaces={surfaceEntries}
          subtotalCents={quote.subtotal_cents}
          taxCents={quote.tax_cents}
          totalCents={quote.total_cents}
          readOnly
        />
      </section>

      {/* Notes */}
      {quote.notes && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {quote.notes}
          </p>
        </section>
      )}

      {/* PDF link */}
      {quote.pdf_url && (
        <section className="flex items-center justify-between rounded-xl border bg-card p-4">
          <div className="flex items-center gap-3">
            <FileText className="size-4 text-muted-foreground" />
            <div className="flex flex-col">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">PDF</span>
              <a
                href={quote.pdf_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline"
              >
                Download quote PDF
              </a>
            </div>
          </div>
        </section>
      )}

      {/* Status history */}
      <section className="rounded-xl border bg-card p-5">
        <header className="flex items-center justify-between pb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            History
          </h2>
          <span className="text-xs text-muted-foreground">{worklog.length}</span>
        </header>
        {worklog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No history yet. Send this quote to start tracking.
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
