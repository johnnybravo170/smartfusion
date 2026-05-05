import { Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { Suspense } from 'react';
import { CustomerEmptyState } from '@/components/features/customers/customer-empty-state';
import { CustomerSearchBar } from '@/components/features/customers/customer-search-bar';
import { CustomerTable } from '@/components/features/customers/customer-table';
import { Button } from '@/components/ui/button';
import { countCustomers, listCustomers } from '@/lib/db/queries/customers';
import {
  type ContactKind,
  type CustomerType,
  contactKinds,
  customerTypes,
} from '@/lib/validators/customer';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseKind(value: string | string[] | undefined): ContactKind | null {
  if (typeof value !== 'string') return null;
  return (contactKinds as readonly string[]).includes(value) ? (value as ContactKind) : null;
}

function parseType(value: string | string[] | undefined): CustomerType | null {
  if (typeof value !== 'string') return null;
  return (customerTypes as readonly string[]).includes(value) ? (value as CustomerType) : null;
}

function parseQuery(value: string | string[] | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

export const metadata = {
  title: 'Contacts — HeyHenry',
};

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const query = parseQuery(resolvedSearchParams.q);
  const kind = parseKind(resolvedSearchParams.kind);
  const type = parseType(resolvedSearchParams.type);
  const hasFilters = Boolean(query || kind || type);

  const [customers, totalCount] = await Promise.all([
    listCustomers({
      search: query || undefined,
      kind: kind ?? undefined,
      type: type ?? undefined,
      limit: 200,
    }),
    hasFilters ? countCustomers() : Promise.resolve(-1),
  ]);

  // When there are no filters, the `customers.length` is the total. When
  // filters are applied, we fetched total separately so we can show whether
  // the database is empty vs. just filtered-empty.
  const grandTotal = hasFilters ? totalCount : customers.length;
  const showingCount = customers.length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            {grandTotal === 0
              ? 'Nobody in the system yet.'
              : hasFilters
                ? `${showingCount} shown of ${grandTotal} contact${grandTotal === 1 ? '' : 's'}`
                : `${grandTotal} contact${grandTotal === 1 ? '' : 's'} on file`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <Link href="/contacts/import">
              <Sparkles className="size-3.5" />
              Import with Henry
            </Link>
          </Button>
          <Button asChild>
            <Link href="/contacts/new">
              <Plus className="size-3.5" />
              New contact
            </Link>
          </Button>
        </div>
      </header>

      {grandTotal > 0 ? (
        <Suspense fallback={null}>
          <CustomerSearchBar defaultQuery={query} />
        </Suspense>
      ) : null}

      {showingCount === 0 ? (
        <CustomerEmptyState variant={grandTotal === 0 ? 'fresh' : 'filtered'} />
      ) : (
        <CustomerTable customers={customers} />
      )}
    </div>
  );
}
