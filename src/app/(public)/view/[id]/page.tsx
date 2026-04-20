import type { Metadata } from 'next';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';
import { QuoteApprovalForm } from './quote-approval-form';

export const metadata: Metadata = {
  title: 'Your Estimate',
  robots: { index: false, follow: false },
};

type LineItem = {
  id: string;
  label: string;
  qty: number;
  unit: string;
  line_total_cents: number;
};

export default async function PublicQuoteViewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = createAdminClient();

  // Load quote with tenant and customer info.
  const { data: quote } = await supabase
    .from('quotes')
    .select(
      'id, tenant_id, customer_id, status, subtotal_cents, tax_cents, total_cents, pdf_url, sent_at, notes, created_at',
    )
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();

  if (!quote || quote.status === 'draft') {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="text-center">
          <h1 className="text-2xl font-semibold text-gray-900">Estimate not available</h1>
          <p className="mt-2 text-gray-500">
            This estimate is no longer available or has not been sent yet.
          </p>
        </div>
      </div>
    );
  }

  // Load tenant info.
  const { data: tenant } = await supabase
    .from('tenants')
    .select('name, quote_validity_days')
    .eq('id', quote.tenant_id)
    .single();

  // Load customer info.
  const { data: customer } = await supabase
    .from('customers')
    .select('name, email, phone, address_line1, city, province, postal_code')
    .eq('id', quote.customer_id)
    .single();

  // Load line items.
  const { data: lineItems } = await supabase
    .from('quote_line_items')
    .select('id, label, qty, unit, line_total_cents')
    .eq('quote_id', id)
    .order('sort_order', { ascending: true });

  const lineItemList = (lineItems ?? []) as LineItem[];
  const businessName = tenant?.name ?? 'Our Company';
  const validityDays = (tenant?.quote_validity_days as number) ?? 30;

  // Calculate valid-until date from sent_at.
  const sentDate = quote.sent_at ? new Date(quote.sent_at) : new Date(quote.created_at);
  const validUntil = new Date(sentDate);
  validUntil.setDate(validUntil.getDate() + validityDays);
  const validUntilFormatted = validUntil.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const quoteDate = sentDate.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const isExpired = validUntil < new Date() && quote.status === 'sent';

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-bold text-gray-900 sm:text-3xl">{businessName}</h1>
        <p className="mt-1 text-sm text-gray-500">Quote #{id.slice(0, 8)}</p>
      </div>

      {/* Quote info */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <span className="text-gray-500">Prepared for</span>
            <p className="font-medium text-gray-900">{customer?.name ?? 'Customer'}</p>
          </div>
          <div>
            <span className="text-gray-500">Date</span>
            <p className="font-medium text-gray-900">{quoteDate}</p>
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
            <p className="font-medium text-gray-900 capitalize">
              {isExpired ? 'Expired' : quote.status}
            </p>
          </div>
        </div>
      </div>

      {/* Line item breakdown */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-5 py-3">Description</th>
              <th className="px-5 py-3 text-right">Qty</th>
              <th className="px-5 py-3 text-right">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lineItemList.map((li) => (
              <tr key={li.id}>
                <td className="px-5 py-3 font-medium text-gray-900">{li.label}</td>
                <td className="px-5 py-3 text-right text-gray-600">
                  {Number(li.qty).toLocaleString()} {li.unit}
                </td>
                <td className="px-5 py-3 text-right text-gray-900">
                  {formatCurrency(li.line_total_cents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="border-t bg-gray-50 px-5 py-3">
          <div className="flex justify-between text-sm text-gray-600">
            <span>Subtotal</span>
            <span>{formatCurrency(quote.subtotal_cents)}</span>
          </div>
          <div className="mt-1 flex justify-between text-sm text-gray-600">
            <span>GST (5%)</span>
            <span>{formatCurrency(quote.tax_cents)}</span>
          </div>
          <div className="mt-2 flex justify-between border-t pt-2 text-base font-semibold text-gray-900">
            <span>Total</span>
            <span>{formatCurrency(quote.total_cents)}</span>
          </div>
        </div>
      </div>

      {/* Notes */}
      {quote.notes && (
        <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Notes
          </h2>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{quote.notes}</p>
        </div>
      )}

      {/* Validity */}
      <div className="mb-6 rounded-xl border border-gray-200 bg-white p-5 text-center shadow-sm">
        {isExpired ? (
          <p className="text-sm text-red-600">
            This estimate expired on {validUntilFormatted}. Please contact {businessName} for an
            updated quote.
          </p>
        ) : (
          <p className="text-sm text-gray-500">
            This estimate is valid until{' '}
            <span className="font-medium text-gray-900">{validUntilFormatted}</span>
          </p>
        )}
      </div>

      {/* PDF download */}
      {quote.pdf_url && (
        <div className="mb-6 text-center">
          <a
            href={quote.pdf_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50"
          >
            Download PDF
          </a>
        </div>
      )}

      {/* Accept / Decline actions (only when status is 'sent' and not expired) */}
      {quote.status === 'sent' && !isExpired && (
        <QuoteApprovalForm quoteId={id} businessName={businessName} />
      )}

      {/* Already accepted */}
      {quote.status === 'accepted' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100">
            <svg
              className="h-7 w-7 text-emerald-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              role="img"
              aria-label="Checkmark"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-900">Estimate Accepted</h2>
          <p className="mt-1 text-sm text-gray-600">
            {businessName} will be in touch to schedule your service.
          </p>
        </div>
      )}

      {/* Already declined */}
      {quote.status === 'rejected' && (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900">Estimate Declined</h2>
          <p className="mt-1 text-sm text-gray-600">
            {businessName} may follow up with an updated estimate.
          </p>
        </div>
      )}
    </div>
  );
}
