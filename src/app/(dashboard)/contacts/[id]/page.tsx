import { ArrowLeft, Calendar, FileText, Mail, MapPin, Pencil, Phone, Receipt } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContactNotesFeed } from '@/components/features/contacts/contact-notes-feed';
import { DoNotAutoMessageToggle } from '@/components/features/contacts/do-not-auto-message-toggle';
import { CustomerTypeBadge } from '@/components/features/customers/customer-type-badge';
import { DeleteCustomerButton } from '@/components/features/customers/delete-customer-button';
import { InvoiceStatusBadge } from '@/components/features/invoices/invoice-status-badge';
import { JobStatusBadge } from '@/components/features/jobs/job-status-badge';
import { QuoteStatusBadge } from '@/components/features/quotes/quote-status-badge';
import { LeadTasksSection } from '@/components/features/tasks/lead-tasks-section';
import { Button } from '@/components/ui/button';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { formatDate as formatDateUtil } from '@/lib/date/format';
import { listContactNotes } from '@/lib/db/queries/contact-notes';
import {
  type CustomerRow,
  getCustomer,
  getCustomerRelated,
  type RelatedInvoice,
  type RelatedJob,
  type RelatedQuote,
} from '@/lib/db/queries/customers';
import { listTasksForLead } from '@/lib/db/queries/tasks';
import type { CustomerType } from '@/lib/validators/customer';
import type { InvoiceStatus } from '@/lib/validators/invoice';
import type { JobStatus } from '@/lib/validators/job';
import type { QuoteStatus } from '@/lib/validators/quote';

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

export default async function ContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const [customer, tenant] = await Promise.all([getCustomer(id), getCurrentTenant()]);
  if (!customer) notFound();
  const tz = tenant?.timezone || 'America/Vancouver';
  const formatDate = (iso: string | null | undefined) => formatDateUtil(iso, { timezone: tz });

  // Only customer-kind contacts have quotes/jobs/invoices — skip the join for
  // every other kind so we don't make three empty round-trips per page load.
  const isCustomerKind = customer.kind === 'customer';
  const isLeadKind = customer.kind === 'lead';
  const [related, notesRows, leadTasks] = await Promise.all([
    isCustomerKind
      ? getCustomerRelated(id)
      : Promise.resolve({ quotes: [], jobs: [], invoices: [] }),
    listContactNotes(id),
    isLeadKind ? listTasksForLead(id) : Promise.resolve([]),
  ]);
  const isOwner = tenant?.member.role === 'owner' || tenant?.member.role === 'admin';
  const notes = notesRows.map((n) => ({
    id: n.id,
    body: n.body,
    authorType: n.author_type,
    metadata: n.metadata ?? {},
    createdAt: n.created_at,
    updatedAt: n.updated_at,
  }));

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div>
        <Link
          href="/contacts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to contacts
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{customer.name}</h1>
            <CustomerTypeBadge type={customer.type as CustomerType} kind={customer.kind} />
          </div>
          <p className="text-sm text-muted-foreground">Added {formatDate(customer.created_at)}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/contacts/${customer.id}/edit`}>
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
            <Link href={`/contacts/${customer.id}/edit`} className="text-foreground underline">
              Add some
            </Link>
            .
          </p>
        ) : null}
      </section>

      <ContactNotesFeed contactId={customer.id} notes={notes} timezone={tz} />

      {customer.email || customer.phone ? (
        <DoNotAutoMessageToggle
          customerId={customer.id}
          enabled={customer.do_not_auto_message}
          setAt={customer.do_not_auto_message_at}
          source={customer.do_not_auto_message_source}
          timezone={tz}
        />
      ) : null}

      {isLeadKind ? (
        <LeadTasksSection leadId={customer.id} tasks={leadTasks} isOwner={isOwner} />
      ) : null}

      {isCustomerKind ? (
        <div className="grid gap-4 md:grid-cols-3">
          <RelatedQuotesCard quotes={related.quotes} timezone={tz} customerId={customer.id} />
          <RelatedJobsCard jobs={related.jobs} timezone={tz} customerId={customer.id} />
          <RelatedInvoicesCard invoices={related.invoices} timezone={tz} />
        </div>
      ) : (
        <KindPlaceholderSection kind={customer.kind} contactId={customer.id} />
      )}
    </div>
  );
}

function KindPlaceholderSection({
  kind,
  contactId,
}: {
  kind: CustomerRow['kind'];
  contactId: string;
}) {
  const copy: Record<
    CustomerRow['kind'],
    { title: string; body: string; cta?: { href: string; label: string } } | null
  > = {
    customer: null,
    lead: {
      title: 'Not a customer yet',
      body: "This contact is a lead — nothing's committed. Start a project to begin drafting an estimate. They'll auto-promote to a customer once you do.",
      cta: { href: `/projects/new?customer=${contactId}`, label: 'Start project' },
    },
    vendor: {
      title: 'Bills from this vendor',
      body: "Vendor bill history will aggregate here once we start linking bills to contact records. For now, bills you've entered live under their projects.",
    },
    sub: {
      title: 'Vendor quotes and jobs',
      body: "Vendor quote history and linked projects will show here once we start linking vendor quotes to contact records. For now, they're scoped to individual projects.",
    },
    agent: {
      title: 'Referrals',
      body: 'Deals brought in by this agent will aggregate here in a future slice.',
    },
    inspector: {
      title: 'Inspections',
      body: 'Inspection history per project will aggregate here in a future slice.',
    },
    referral: {
      title: 'Leads sent',
      body: 'Leads this partner has sent will aggregate here in a future slice.',
    },
    other: null,
  };
  const entry = copy[kind];
  if (!entry) return null;
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-dashed bg-card/60 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground">{entry.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{entry.body}</p>
      </div>
      {entry.cta ? (
        <Button asChild size="sm" className="self-start sm:self-center">
          <Link href={entry.cta.href}>{entry.cta.label}</Link>
        </Button>
      ) : null}
    </section>
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
          <Link href={actionHref} className="text-xs font-medium text-primary hover:underline">
            + {actionLabel || 'New'}
          </Link>
        )}
      </header>
      {children}
    </section>
  );
}

function RelatedQuotesCard({
  quotes,
  timezone,
  customerId,
}: {
  quotes: RelatedQuote[];
  timezone: string;
  customerId: string;
}) {
  return (
    <SectionCard
      title="Recent quotes"
      icon={FileText}
      count={quotes.length}
      actionHref={`/quotes/new?customer_id=${customerId}`}
      actionLabel="New quote"
    >
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
                  <QuoteStatusBadge status={q.status as QuoteStatus} />
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

function RelatedJobsCard({
  jobs,
  timezone,
  customerId,
}: {
  jobs: RelatedJob[];
  timezone: string;
  customerId: string;
}) {
  return (
    <SectionCard
      title="Recent jobs"
      icon={Calendar}
      count={jobs.length}
      actionHref={`/jobs/new?customer_id=${customerId}`}
      actionLabel="New job"
    >
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
                  <JobStatusBadge status={j.status as JobStatus} />
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
                  <InvoiceStatusBadge status={inv.status as InvoiceStatus} />
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
