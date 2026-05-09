import { Briefcase, Copy, User } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { InvoiceActions } from '@/components/features/invoices/invoice-actions';
import { InvoiceDefaultsSetupBanner } from '@/components/features/invoices/invoice-defaults-setup-banner';
import { InvoiceLineItems } from '@/components/features/invoices/invoice-line-items';
import { InvoiceNote } from '@/components/features/invoices/invoice-note';
import { InvoiceOverridesEditor } from '@/components/features/invoices/invoice-overrides-editor';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
import { MissingGstNotice } from '@/components/features/invoices/missing-gst-notice';
import { PrintButton } from '@/components/features/shared/print-button';
import { DetailPageNav } from '@/components/layout/detail-page-nav';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDateTime } from '@/lib/date/format';
import { getInvoice } from '@/lib/db/queries/invoices';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { getSignedUrls } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import { duplicateInvoiceAction } from '@/server/actions/invoices';

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

  // Check if tenant has Stripe connected and load invoice doc defaults.
  const supabase = await createClient();
  const { data: tenantRow } = await supabase
    .from('tenants')
    .select(
      'stripe_account_id, gst_number, wcb_number, invoice_payment_instructions, invoice_terms, invoice_policies',
    )
    .eq('id', tenant?.id ?? '')
    .maybeSingle();
  const hasStripe = !!tenantRow?.stripe_account_id;
  const gstNumber = (tenantRow?.gst_number as string | null) ?? null;
  const wcbNumber = (tenantRow?.wcb_number as string | null) ?? null;
  const docFields = {
    payment_instructions: (tenantRow?.invoice_payment_instructions as string | null) ?? null,
    terms: (tenantRow?.invoice_terms as string | null) ?? null,
    policies: (tenantRow?.invoice_policies as string | null) ?? null,
  };
  const showSetupBanner = invoice.status === 'draft' || invoice.status === 'sent';
  const regParts = [
    gstNumber ? `GST: ${gstNumber}` : null,
    wcbNumber ? `WCB: ${wcbNumber}` : null,
  ].filter(Boolean);

  // Load worklog entries for this invoice's job.
  const { data: worklog } = await supabase
    .from('worklog_entries')
    .select('id, entry_type, title, body, created_at')
    .eq('related_type', 'job')
    .eq('related_id', invoice.job_id)
    .ilike('title', '%invoice%')
    .order('created_at', { ascending: false });

  const lineItems = invoice.line_items ?? [];
  const lineItemsTotal = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  // Mirror the customer-facing public view:
  //  - tax_inclusive: amount_cents IS the customer total; line_items
  //    are a breakdown summing to it; tax_cents is embedded GST.
  //  - tax_exclusive: line_items are additive on top of amount_cents
  //    (per addInvoiceLineItemAction's contract), so subtotal sums
  //    both. New estimate-derived drafts write amount_cents=0 and
  //    everything in line_items; legacy drafts had amount_cents=full
  //    subtotal and line_items=[] until additions — both render
  //    correctly under amount + items.
  const taxInclusive = Boolean(invoice.tax_inclusive);
  const subtotalCents = taxInclusive
    ? invoice.amount_cents - invoice.tax_cents
    : invoice.amount_cents + lineItemsTotal;
  const totalCents = taxInclusive ? invoice.amount_cents : subtotalCents + invoice.tax_cents;
  const showSubtotalRow = !(taxInclusive && lineItems.length > 0);
  const taxCtx = tenant ? await canadianTax.getCustomerFacingContext(tenant.id) : null;
  const ratePct = taxCtx ? Math.round(taxCtx.totalRate * 100) : 5;
  const taxLabel = taxInclusive ? `GST (${ratePct}%, included)` : `GST (${ratePct}%)`;
  const isDraft = invoice.status === 'draft';

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <DetailPageNav homeHref="/invoices" homeLabel="All invoices" />

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
        {(invoice.status === 'paid' || invoice.status === 'void') && (
          <DuplicateInvoiceButton invoiceId={invoice.id} />
        )}
      </header>

      {/* Amount breakdown */}
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-col gap-2">
          {showSubtotalRow ? (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Subtotal</span>
              <span>{formatCad(subtotalCents)}</span>
            </div>
          ) : null}
          <InvoiceLineItems invoiceId={invoice.id} lineItems={lineItems} isDraft={isDraft} />
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{taxLabel}</span>
            <span>{formatCad(invoice.tax_cents)}</span>
          </div>
          <div className="border-t pt-2">
            <div className="flex items-center justify-between text-base font-semibold">
              <span>Total</span>
              <span>{formatCad(totalCents)}</span>
            </div>
          </div>
          {regParts.length > 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">{regParts.join('  ·  ')}</p>
          ) : null}
        </div>
      </section>

      {/* Customer note */}
      <InvoiceNote invoiceId={invoice.id} note={invoice.customer_note} isDraft={isDraft} />

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
                  href={`/contacts/${invoice.customer.id}`}
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
        <PaidSection
          paidAt={formatTimestamp(invoice.paid_at)}
          method={invoice.payment_method}
          reference={invoice.payment_reference}
          notes={invoice.payment_notes}
          receiptPaths={invoice.payment_receipt_paths ?? []}
        />
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

      {/* Defense-in-depth GST# warning — gate at send time should make
       *  this impossible, but if a draft predates the gate or the field
       *  was cleared, surface it inline so the operator can fix it
       *  without bouncing to settings. */}
      {showSetupBanner && !gstNumber ? <MissingGstNotice /> : null}

      {/* Inline default-fields setup — pops a dialog, no Settings detour */}
      {showSetupBanner ? <InvoiceDefaultsSetupBanner current={docFields} /> : null}

      {/* Per-invoice override of payment instructions / terms / policies */}
      {showSetupBanner ? (
        <InvoiceOverridesEditor
          invoiceId={invoice.id}
          override={{
            payment_instructions: invoice.payment_instructions_override ?? null,
            terms: invoice.terms_override ?? null,
            policies: invoice.policies_override ?? null,
          }}
          tenant={docFields}
        />
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <InvoiceActions
          invoiceId={invoice.id}
          status={invoice.status as InvoiceStatus}
          paymentUrl={invoice.pdf_url}
          customerEmail={invoice.customer?.email ?? null}
          customerAdditionalEmails={invoice.customer?.additional_emails ?? []}
          hasStripe={hasStripe}
          invoiceTotalCents={totalCents}
        />
        <PrintButton />
      </div>

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

async function PaidSection({
  paidAt,
  method,
  reference,
  notes,
  receiptPaths,
}: {
  paidAt: string;
  method: string | null;
  reference: string | null;
  notes: string | null;
  receiptPaths: string[];
}) {
  const urlMap = receiptPaths.length > 0 ? await getSignedUrls(receiptPaths) : new Map();

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/30">
      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
        Paid on {paidAt}
        {method ? ` via ${method}` : ''}
        {reference ? ` (ref ${reference})` : ''}
      </p>
      {notes ? (
        <p className="whitespace-pre-line text-sm text-emerald-900/80 dark:text-emerald-200/80">
          {notes}
        </p>
      ) : null}
      {receiptPaths.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {receiptPaths.map((path) => {
            const url = urlMap.get(path);
            if (!url) {
              return (
                <div
                  key={path}
                  className="flex size-20 items-center justify-center rounded-md border bg-muted text-xs text-muted-foreground"
                >
                  Missing
                </div>
              );
            }
            return (
              <a
                key={path}
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block size-20 overflow-hidden rounded-md border bg-background"
              >
                {/* biome-ignore lint/performance/noImgElement: signed URLs bypass next/image optimizer */}
                <img
                  src={url}
                  alt="Payment receipt"
                  className="size-full object-cover transition-transform hover:scale-105"
                />
              </a>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function DuplicateInvoiceButton({ invoiceId }: { invoiceId: string }) {
  async function action() {
    'use server';
    const result = await duplicateInvoiceAction({ invoiceId });
    if (!result.ok) throw new Error(result.error);
    const { redirect } = await import('next/navigation');
    redirect(`/invoices/${result.id}`);
  }

  return (
    <form action={action}>
      <Button type="submit" variant="outline" size="sm">
        <Copy className="size-3.5" />
        Duplicate
      </Button>
    </form>
  );
}
