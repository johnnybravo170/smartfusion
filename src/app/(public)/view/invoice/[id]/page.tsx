import type { Metadata } from 'next';
import { PublicViewLogger } from '@/components/features/public/public-view-logger';
import { formatDate } from '@/lib/date/format';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata: Metadata = {
  title: 'Your Invoice',
  robots: { index: false, follow: false },
};

type LineItem = {
  description: string;
  quantity: number;
  unit_price_cents: number;
  total_cents: number;
};

export default async function PublicInvoiceViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = createAdminClient();

  // Load invoice.
  const { data: invoice } = await supabase
    .from('invoices')
    .select(
      'id, tenant_id, customer_id, status, doc_type, tax_inclusive, percent_complete, amount_cents, tax_cents, line_items, customer_note, pdf_url, sent_at, paid_at, created_at, payment_instructions_override, terms_override, policies_override',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!invoice || invoice.status === 'draft') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900">Invoice not available</h1>
          <p className="mt-2 text-gray-500">
            This invoice is no longer available or has not been sent yet.
          </p>
        </div>
      </div>
    );
  }

  // Load tenant info.
  const { data: tenant } = await supabase
    .from('tenants')
    .select(
      'name, gst_number, wcb_number, invoice_payment_instructions, invoice_terms, invoice_policies, timezone',
    )
    .eq('id', invoice.tenant_id)
    .single();

  // Load customer info.
  const { data: customer } = await supabase
    .from('customers')
    .select('name, email, phone, address_line1, city, province, postal_code')
    .eq('id', invoice.customer_id)
    .single();

  const businessName = tenant?.name ?? 'Our Company';
  const gstNumber = (tenant?.gst_number as string | null) ?? null;
  const wcbNumber = (tenant?.wcb_number as string | null) ?? null;
  const { resolveInvoiceDocFields } = await import('@/lib/invoices/default-doc-fields');
  const resolvedDocs = resolveInvoiceDocFields({
    override: {
      payment_instructions: (invoice.payment_instructions_override as string | null) ?? null,
      terms: (invoice.terms_override as string | null) ?? null,
      policies: (invoice.policies_override as string | null) ?? null,
    },
    tenant: {
      payment_instructions: (tenant?.invoice_payment_instructions as string | null) ?? null,
      terms: (tenant?.invoice_terms as string | null) ?? null,
      policies: (tenant?.invoice_policies as string | null) ?? null,
    },
  });
  const docPayment = resolvedDocs.payment_instructions;
  const docTerms = resolvedDocs.terms;
  const docPolicies = resolvedDocs.policies;
  const regParts = [
    gstNumber ? `GST: ${gstNumber}` : null,
    wcbNumber ? `WCB: ${wcbNumber}` : null,
  ].filter(Boolean);
  const lineItems = ((invoice.line_items as LineItem[] | null) ?? []) as LineItem[];
  const lineItemsTotal = lineItems.reduce((sum, li) => sum + li.total_cents, 0);
  // tax_inclusive (draws): amount_cents IS the customer total. line_items,
  // when present (milestone draws), are a breakdown summing to amount_cents,
  // not added on top. tax_cents is the embedded GST portion shown for
  // transparency. Otherwise (tax_exclusive): line_items are additive on top
  // of amount_cents (matches addInvoiceLineItemAction). Estimate-derived
  // drafts write amount_cents=0 and the full breakdown in line_items;
  // legacy invoices had amount_cents=subtotal with line_items=[] — both
  // render correctly under amount + items.
  const taxInclusive = Boolean(invoice.tax_inclusive);
  const subtotalCents = taxInclusive
    ? invoice.amount_cents - invoice.tax_cents
    : invoice.amount_cents + lineItemsTotal;
  const totalCents = taxInclusive ? invoice.amount_cents : subtotalCents + invoice.tax_cents;
  // For inclusive draws with a line-item breakdown, the line items already
  // serve as the subtotal — hide the standalone Subtotal row to avoid an
  // apparent double-count in the customer-facing breakdown.
  const showSubtotalRow = !(taxInclusive && lineItems.length > 0);
  // Back-compute the rate from the stored numbers so HST tenants render
  // "GST (13%)" / "GST (15%)" without having to thread tenant context here.
  const ratePct = taxInclusive
    ? subtotalCents > 0
      ? Math.round((invoice.tax_cents / subtotalCents) * 100)
      : 5
    : invoice.amount_cents > 0
      ? Math.round((invoice.tax_cents / invoice.amount_cents) * 100)
      : 5;

  const tenantTz = (tenant?.timezone as string | null) ?? undefined;
  const invoiceDate = formatDate(invoice.sent_at ?? invoice.created_at, {
    timezone: tenantTz,
    style: 'long',
  });

  const isPaid = invoice.status === 'paid';
  const isVoid = invoice.status === 'void';
  const paymentUrl = invoice.pdf_url;
  const isDraw = invoice.doc_type === 'draw';
  const docLabel = isDraw ? 'Draw Request' : 'Invoice';
  const percentComplete = (invoice.percent_complete as number | null) ?? null;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      <PublicViewLogger resourceType="invoice" identifier={id} />
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{businessName}</h1>
        <p className="mt-1 text-sm text-gray-500">
          {docLabel} #{id.slice(0, 8)}
        </p>
        {isDraw ? (
          <p className="mt-1 text-xs text-gray-500">
            Progress payment against your accepted estimate
            {percentComplete !== null ? ` — ${percentComplete}% complete` : ''}. Will be reconciled
            against the final invoice on completion.
          </p>
        ) : null}
      </div>

      {/* Status banner */}
      {isPaid && (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center">
          <p className="text-sm font-medium text-emerald-800">
            This {docLabel.toLowerCase()} has been paid.
            {invoice.paid_at &&
              ` Paid on ${formatDate(invoice.paid_at, { timezone: tenantTz, style: 'long' })}.`}
          </p>
        </div>
      )}
      {isVoid && (
        <div className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-center">
          <p className="text-sm font-medium text-red-800">
            This {docLabel.toLowerCase()} has been voided.
          </p>
        </div>
      )}

      {/* Invoice info */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-gray-500">Billed to</span>
            <p className="font-medium text-gray-900">{customer?.name ?? 'Customer'}</p>
          </div>
          <div>
            <span className="text-gray-500">{docLabel} date</span>
            <p className="font-medium text-gray-900">{invoiceDate}</p>
          </div>
          {customer?.address_line1 && (
            <div>
              <span className="text-gray-500">Address</span>
              <p className="font-medium text-gray-900">
                {customer.address_line1}
                {customer.city ? `, ${customer.city}` : ''}
                {customer.province ? `, ${customer.province}` : ''}
                {customer.postal_code ? ` ${customer.postal_code}` : ''}
              </p>
            </div>
          )}
          <div>
            <span className="text-gray-500">Status</span>
            <p className="font-medium text-gray-900 capitalize">{invoice.status}</p>
          </div>
        </div>
      </div>

      {/* Amount breakdown */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b bg-gray-50 px-5 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
            Amount
          </span>
        </div>
        <div className="px-5 py-3">
          {showSubtotalRow ? (
            <div className="flex justify-between text-sm text-gray-600">
              <span>Subtotal</span>
              <span>{formatCurrency(subtotalCents)}</span>
            </div>
          ) : null}

          {/* Line items */}
          {lineItems.map((li) => (
            <div key={li.description} className="mt-1 flex justify-between text-sm text-gray-600">
              <span>
                {li.description} (x{li.quantity})
              </span>
              <span>{formatCurrency(li.total_cents)}</span>
            </div>
          ))}

          <div className="mt-1 flex justify-between text-sm text-gray-600">
            <span>{taxInclusive ? `GST (${ratePct}%, included)` : `GST (${ratePct}%)`}</span>
            <span>{formatCurrency(invoice.tax_cents)}</span>
          </div>
          <div className="mt-2 flex justify-between border-t pt-2 text-base font-semibold text-gray-900">
            <span>Total</span>
            <span>{formatCurrency(totalCents)}</span>
          </div>
          {regParts.length > 0 ? (
            <p className="mt-3 text-xs text-gray-400">{regParts.join('  ·  ')}</p>
          ) : null}
        </div>
      </div>

      {/* Customer note */}
      {invoice.customer_note && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Note</h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
            {invoice.customer_note}
          </p>
        </div>
      )}

      {/* How to pay / Terms / Policies — only render when set on tenant */}
      {!isPaid && !isVoid && docPayment ? (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            How to pay
          </h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{docPayment}</p>
        </div>
      ) : null}
      {docTerms ? (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Terms
          </h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{docTerms}</p>
        </div>
      ) : null}
      {docPolicies ? (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Policies
          </h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{docPolicies}</p>
        </div>
      ) : null}

      {/* Pay button (only if sent + has Stripe payment URL) */}
      {invoice.status === 'sent' && paymentUrl && (
        <div className="text-center">
          <a
            href={paymentUrl}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-6 py-3 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gray-800"
          >
            Pay Now
          </a>
        </div>
      )}
    </div>
  );
}
