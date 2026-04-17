import { Plus } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { QuoteEmptyState } from '@/components/features/quotes/quote-empty-state';
import { QuoteStatusFilter } from '@/components/features/quotes/quote-status-filter';
import { QuoteTable } from '@/components/features/quotes/quote-table';
import { Button } from '@/components/ui/button';
import { countQuotesByStatus, listQuotes } from '@/lib/db/queries/quotes';
import { type QuoteStatus, quoteStatuses } from '@/lib/validators/quote';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseStatus(value: string | string[] | undefined): QuoteStatus | undefined {
  if (typeof value !== 'string') return undefined;
  return (quoteStatuses as readonly string[]).includes(value) ? (value as QuoteStatus) : undefined;
}

export const metadata = {
  title: 'Quotes — HeyHenry',
};

export default async function QuotesPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const resolvedParams = await searchParams;
  const statusFilter = parseStatus(resolvedParams.status);

  const [quotes, counts] = await Promise.all([
    listQuotes({ status: statusFilter, limit: 200 }),
    countQuotesByStatus(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Quotes</h1>
          <p className="text-sm text-muted-foreground">
            {counts.all === 0
              ? 'No quotes yet.'
              : `${counts.all} quote${counts.all === 1 ? '' : 's'} total`}
          </p>
        </div>
        <Button asChild>
          <Link href="/quotes/new">
            <Plus className="size-3.5" />
            New quote
          </Link>
        </Button>
      </header>

      {counts.all > 0 && (
        <Suspense fallback={null}>
          <QuoteStatusFilter counts={counts} />
        </Suspense>
      )}

      {quotes.length === 0 ? (
        <QuoteEmptyState variant={counts.all === 0 ? 'fresh' : 'filtered'} />
      ) : (
        <QuoteTable quotes={quotes} />
      )}
    </div>
  );
}
