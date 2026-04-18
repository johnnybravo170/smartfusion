import type { Metadata } from 'next';
import { formatCurrency } from '@/lib/pricing/calculator';
import { createAdminClient } from '@/lib/supabase/admin';

export const metadata: Metadata = {
  title: 'Your Quote',
  robots: { index: false, follow: false },
};

type Surface = {
  id: string;
  surface_type: string;
  sqft: number;
  price_cents: number;
  notes: string | null;
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
          <h1 className="text-2xl font-semibold text-gray-900">Quote not available</h1>
          <p className="mt-2 text-gray-500">
            This quote is no longer available or has not been sent yet.
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

  // Load surfaces.
  const { data: surfaces } = await supabase
    .from('quote_surfaces')
    .select('id, surface_type, sqft, price_cents, notes')
    .eq('quote_id', id)
    .order('created_at', { ascending: true });

  const surfaceList = (surfaces ?? []) as Surface[];
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
            <span className="text-gray-500">Quote date</span>
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

      {/* Surface breakdown */}
      <div className="mb-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
              <th className="px-5 py-3">Surface</th>
              <th className="px-5 py-3 text-right">Sq ft</th>
              <th className="px-5 py-3 text-right">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {surfaceList.map((s) => (
              <tr key={s.id}>
                <td className="px-5 py-3 font-medium text-gray-900">
                  {s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}
                </td>
                <td className="px-5 py-3 text-right text-gray-600">{s.sqft.toLocaleString()}</td>
                <td className="px-5 py-3 text-right text-gray-900">
                  {formatCurrency(s.price_cents)}
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
            This quote expired on {validUntilFormatted}. Please contact {businessName} for an
            updated quote.
          </p>
        ) : (
          <p className="text-sm text-gray-500">
            Valid until <span className="font-medium text-gray-900">{validUntilFormatted}</span>
          </p>
        )}
      </div>

      {/* PDF download */}
      {quote.pdf_url && (
        <div className="text-center">
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
    </div>
  );
}
