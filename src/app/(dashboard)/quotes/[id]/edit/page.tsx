import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { QuoteForm } from '@/components/features/quotes/quote-form';
import { requireTenant } from '@/lib/auth/helpers';
import { listCustomers } from '@/lib/db/queries/customers';
import { getQuote } from '@/lib/db/queries/quotes';
import { listCatalogEntries } from '@/lib/db/queries/service-catalog';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { updateQuoteAction } from '@/server/actions/quotes';

export const metadata = {
  title: 'Edit quote — HeyHenry',
};

export default async function EditQuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const { tenant } = await requireTenant();
  const [quote, customers, catalog, taxCtx] = await Promise.all([
    getQuote(id),
    listCustomers({ limit: 500 }),
    listCatalogEntries(),
    canadianTax.getContext(tenant.id),
  ]);

  if (!quote) notFound();

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href={`/quotes/${quote.id}`}
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to quote
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Edit quote</h1>
        <p className="text-sm text-muted-foreground">
          Quote <span className="font-mono">#{quote.id.slice(0, 8)}</span> for{' '}
          {quote.customer?.name ?? 'Unknown customer'}
        </p>
      </header>

      <QuoteForm
        mode="edit"
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        catalog={catalog}
        taxRate={taxCtx.totalRate}
        defaults={{
          id: quote.id,
          customer_id: quote.customer_id,
          notes: quote.notes ?? '',
          surfaces: quote.surfaces.map((s) => ({
            id: s.id,
            surface_type: s.surface_type,
            polygon_geojson: s.polygon_geojson,
            sqft: s.sqft,
            price_cents: s.price_cents,
            notes: s.notes ?? '',
          })),
        }}
        action={updateQuoteAction}
        cancelHref={`/quotes/${quote.id}`}
      />
    </div>
  );
}
