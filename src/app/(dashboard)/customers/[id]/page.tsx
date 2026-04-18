import { ArrowLeft, Calendar, FileText, Mail, MapPin, Pencil, Phone, Receipt } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CustomerTypeBadge } from '@/components/features/customers/customer-type-badge';
import { DeleteCustomerButton } from '@/components/features/customers/delete-customer-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDate as formatDateUtil } from '@/lib/date/format';
import {
  type CustomerRow,
  getCustomer,
  getCustomerRelated,
  type RelatedInvoice,
  type RelatedJob,
  type RelatedQuote,
} from '@/lib/db/queries/customers';
import type { CustomerType } from '@/lib/validators/customer';

const currencyFormatter = new Intl.NumberFormat('en-CA', {
  style: 'currency',
  currency: 'CAD',
});

function formatCents(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return '\u2014';
  return currencyFormatter.format(cents / 100);
}

function shortId(id: string) {
  return id.slice(0, 8);
}

const QUOTE_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  sent: { label: 'Sent', className: 'bg-blue-100 text-blue-800' },
  accepted: { label: 'Accepted', className: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', className: 'bg-destructive/10 text-destructive' },
  expired: { label: 'Expired', className: 'bg-muted text-muted-foreground' },
};

const JOB_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  booked: { label: 'Booked', className: 'bg-blue-100 text-blue-800' },
  in_progress: { label: 'In progress', className: 'bg-amber-100 text-amber-900' },
  complete: { label: 'Complete', className: 'bg-emerald-100 text-emerald-800' },
  cancelled: { label: 'Cancelled', className: 'bg-muted text-muted-foreground' },
};

const INVOICE_STATUS_LABELS: Record<string, { label: string; className: string }> = {
  draft: { label: 'Draft', className: 'bg-muted text-muted-foreground' },
  sent: { label: 'Sent', className: 'bg-blue-100 text-blue-800' },
  paid: { label: 'Paid', className: 'bg-emerald-100 text-emerald-800' },
  void: { label: 'Void', className: 'bg-destructive/10 text-destructive' },
};

function StatusPill({
  status,
  map,
}: {
  status: string;
  map: Record<string, { label: string; className: string }>;
}) {
  const entry = map[status] ?? { label: status, className: 'bg-muted text-muted-foreground' };
  return (
    <Badge variant="secondary" className={`font-medium ${entry.className}`}>
      {entry.label}
    </Badge>
  );
}

function ContactRow({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Mail;
  label: string;
  value: string | null;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="flex flex-col">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
        <span className="text-sm text-foreground">{value}</span>
      </div>
    </div>
  );
}

function addressLines(customer: CustomerRow): string | null {
  const line1 = customer.address_line1;
  const cityPart = [customer.city, customer.province].filter(Boolean).join(', ');
  const parts = [line1, cityPart, customer.postal_code].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : null;
}

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [customer, tenant] = await Promise.all([getCustomer(id), getCurrentTenant()]);
  if (!customer) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';
  const formatDate = (iso: string | null | undefined) => formatDateUtil(iso, { timezone: tz });

  const related = await getCustomerRelated(id);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to customers
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
            <CustomerTypeBadge type={customer.type as CustomerType} />
          </div>
          <p className="text-sm text-muted-foreground">Added {formatDate(customer.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/customers/${customer.id}/edit`}>
              <Pencil className="size-3.5" />
              Edit
            </Link>
          </Button>
          <DeleteCustomerButton customerId={customer.id} customerName={customer.name} />
        </div>
      </header>

      <section className="grid gap-4 rounded-xl border bg-card p-5 md:grid-cols-3">
        <ContactRow icon={Mail} label="Email" value={customer.email} />
        <ContactRow icon={Phone} label="Phone" value={customer.phone} />
        <ContactRow icon={MapPin} label="Address" value={addressLines(customer)} />
        {!customer.email && !customer.phone && !addressLines(customer) ? (
          <p className="md:col-span-3 text-sm text-muted-foreground">
            No contact details yet.{' '}
            <Link href={`/customers/${customer.id}/edit`} className="text-foreground underline">
              Add some
            </Link>
            .
          </p>
        ) : null}
      </section>

      {customer.notes ? (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Notes
          </h2>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
            {customer.notes}
          </p>
        </section>
      ) : null}

      <div className="grid gap-4 md:grid-cols-3">
        <RelatedQuotesCard quotes={related.quotes} timezone={tz} customerId={customer.id} />
        <RelatedJobsCard jobs={related.jobs} timezone={tz} customerId={customer.id} />
        <RelatedInvoicesCard invoices={related.invoices} timezone={tz} />
      </div>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  count,
  actionHref,
  actionLabel,
  children,
}: {
  title: string;
  icon: typeof FileText;
  count: number;
  actionHref?: string;
  actionLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold">{title}</h2>
          <span className="text-xs text-muted-foreground">{count}</span>
        </div>
        {actionHref && (
          <Link
            href={actionHref}
            className="text-xs font-medium text-primary hover:underline"
          >
            + {actionLabel || 'New'}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function RelatedQuotesCard({ quotes, timezone, customerId }: { quotes: RelatedQuote[]; timezone: string; customerId: string }) {
  return (
    <SectionCard title="Recent quotes" icon={FileText} count={quotes.length} actionHref={`/quotes/new?customer_id=${customerId}`} actionLabel="New quote">
      {quotes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No quotes yet.</p>
      ) : (
        <ul className="divide-y">
          {quotes.map((q) => (
            <li key={q.id}>
              <Link
                href={`/quotes/${q.id}`}
                className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-muted/50 rounded-md px-1 -mx-1 transition-colors"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-xs text-muted-foreground">#{shortId(q.id)}</span>
                  <StatusPill status={q.status} map={QUOTE_STATUS_LABELS} />
                </div>
                <div className="flex flex-col items-end">
                  <span className="font-medium">{formatCents(q.total_cents)}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateUtil(q.created_at, { timezone })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RelatedJobsCard({ jobs, timezone, customerId }: { jobs: RelatedJob[]; timezone: string; customerId: string }) {
  return (
    <SectionCard title="Recent jobs" icon={Calendar} count={jobs.length} actionHref={`/jobs/new?customer_id=${customerId}`} actionLabel="New job">
      {jobs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No jobs yet.</p>
      ) : (
        <ul className="divide-y">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                href={`/jobs/${j.id}`}
                className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-muted/50 rounded-md px-1 -mx-1 transition-colors"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-xs text-muted-foreground">#{shortId(j.id)}</span>
                  <StatusPill status={j.status} map={JOB_STATUS_LABELS} />
                </div>
                <div className="flex flex-col items-end">
                  <span className="text-xs text-muted-foreground">
                    {j.scheduled_at
                      ? `Scheduled ${formatDateUtil(j.scheduled_at, { timezone })}`
                      : `Added ${formatDateUtil(j.created_at, { timezone })}`}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RelatedInvoicesCard({
  invoices,
  timezone,
}: {
  invoices: RelatedInvoice[];
  timezone: string;
}) {
  return (
    <SectionCard title="Recent invoices" icon={Receipt} count={invoices.length}>
      {invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
      ) : (
        <ul className="divide-y">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <Link
                href={`/invoices/${inv.id}`}
                className="flex items-center justify-between gap-3 py-2 text-sm hover:bg-muted/50 rounded-md px-1 -mx-1 transition-colors"
              >
                <div className="flex flex-col">
                  <span className="font-mono text-xs text-muted-foreground">
                    #{shortId(inv.id)}
                  </span>
                  <StatusPill status={inv.status} map={INVOICE_STATUS_LABELS} />
                </div>
                <div className="flex flex-col items-end">
                  <span className="font-medium">
                    {formatCents((inv.amount_cents ?? 0) + (inv.tax_cents ?? 0))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateUtil(inv.created_at, { timezone })}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
