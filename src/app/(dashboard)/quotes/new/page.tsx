import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { QuoteForm } from '@/components/features/quotes/quote-form';
import { requireTenant } from '@/lib/auth/helpers';
import { listMapQuoteCatalog } from '@/lib/db/queries/catalog-items';
import { listCustomers } from '@/lib/db/queries/customers';
import { canadianTax } from '@/lib/providers/tax/canadian';
import { createQuoteAction } from '@/server/actions/quotes';

type RawSearchParams = Record<string, string | string[] | undefined>;

export const metadata = {
  title: 'New quote — HeyHenry',
};

function parseCustomerId(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string') return null;
  return /^[0-9a-f-]{36}$/i.test(value) ? value : null;
}

export default async function NewQuotePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // Renovation/tile use projects for estimates — no polygon quoting.
  const { tenant } = await requireTenant();
  if (tenant.vertical === 'renovation' || tenant.vertical === 'tile') {
    redirect('/projects/new');
  }

  const resolvedParams = await searchParams;
  const prefilledCustomerId = parseCustomerId(resolvedParams.customer_id);

  const [customers, catalog, taxCtx] = await Promise.all([
    listCustomers({ limit: 500 }),
    listMapQuoteCatalog(),
    // Customer-facing: the rate here must match the total the customer signs.
    canadianTax.getCustomerFacingContext(tenant.id),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/quotes"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to quotes
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New quote</h1>
        <p className="text-sm text-muted-foreground">
          Draw polygons on the satellite map to measure surfaces, or enter areas manually.
        </p>
      </header>

      {customers.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-6 text-sm">
          <p className="font-medium">You need a customer first.</p>
          <p className="mt-1 text-muted-foreground">
            Quotes are always tied to a customer.{' '}
            <Link href="/contacts/new" className="text-foreground underline">
              Add one
            </Link>{' '}
            and come back.
          </p>
        </div>
      ) : catalog.length === 0 ? (
        <div className="rounded-xl border border-dashed bg-card p-6 text-sm">
          <p className="font-medium">Set up your pricebook first.</p>
          <p className="mt-1 text-muted-foreground">
            You need at least one per-sqft surface item to create quotes.{' '}
            <Link href="/settings/pricebook" className="text-foreground underline">
              Set up pricing
            </Link>{' '}
            and come back.
          </p>
        </div>
      ) : (
        <QuoteForm
          mode="create"
          customers={customers.map((c) => ({ id: c.id, name: c.name }))}
          catalog={catalog}
          taxRate={taxCtx.totalRate}
          defaults={prefilledCustomerId ? { customer_id: prefilledCustomerId } : undefined}
          action={createQuoteAction}
          cancelHref="/quotes"
        />
      )}
    </div>
  );
}
