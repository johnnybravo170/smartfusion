'use client';

/**
 * Search + kind/subtype filter for the contacts list.
 *
 * State lives in the URL (`?q=…&kind=…&type=…`) so links are shareable and the
 * browser back button works. Typing is debounced (300ms) so we don't thrash
 * the server on every keystroke.
 *
 * Filter hierarchy:
 *   - Kind chip row: All / Customers / Vendors / Subs / Agents / Inspectors / Referrals / Other
 *   - When kind=customer is active, a second row appears with the customer
 *     subtype chips (Residential / Commercial).
 */

import { Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  type ContactKind,
  type CustomerType,
  contactKindLabels,
  contactKinds,
  customerTypeLabels,
} from '@/lib/validators/customer';

const DEBOUNCE_MS = 300;

/** Customer subtypes for the secondary filter row (agent lives on kind, not here). */
const CUSTOMER_SUBTYPES = ['residential', 'commercial'] as const;

export function CustomerSearchBar({ defaultQuery }: { defaultQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(defaultQuery);
  const [, startTransition] = useTransition();

  const currentKind = useMemo<ContactKind | null>(() => {
    const raw = searchParams?.get('kind');
    if (!raw) return null;
    return (contactKinds as readonly string[]).includes(raw) ? (raw as ContactKind) : null;
  }, [searchParams]);

  const currentSubtype = useMemo<CustomerType | null>(() => {
    const raw = searchParams?.get('type');
    if (raw === 'residential' || raw === 'commercial') return raw;
    return null;
  }, [searchParams]);

  const paramsString = searchParams?.toString();

  // Debounce the search query.
  useEffect(() => {
    const params = new URLSearchParams(paramsString);
    const current = params.get('q') ?? '';
    if (query === current) return;

    const id = setTimeout(() => {
      if (query) params.set('q', query);
      else params.delete('q');
      startTransition(() => {
        router.replace(`/contacts?${params.toString()}`);
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(id);
  }, [query, paramsString, router]);

  function applyKind(next: ContactKind | null) {
    const params = new URLSearchParams(searchParams?.toString());
    if (next) params.set('kind', next);
    else params.delete('kind');
    // Changing kind clears any subtype filter (subtype only meaningful for
    // kind=customer).
    if (next !== 'customer') params.delete('type');
    startTransition(() => {
      router.replace(`/contacts?${params.toString()}`);
    });
  }

  function applySubtype(next: CustomerType | null) {
    const params = new URLSearchParams(searchParams?.toString());
    if (next) params.set('type', next);
    else params.delete('type');
    // Subtype implies kind=customer.
    params.set('kind', 'customer');
    startTransition(() => {
      router.replace(`/contacts?${params.toString()}`);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative flex items-center">
        <Search
          aria-hidden
          className="pointer-events-none absolute left-3 size-4 text-muted-foreground"
        />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, phone, or city…"
          className="h-9 w-full pl-9 pr-9"
          aria-label="Search contacts"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery('')}
            className="absolute right-2 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Kind:
        </span>
        <FilterChip label="All" active={currentKind === null} onClick={() => applyKind(null)} />
        {contactKinds.map((k) => (
          <FilterChip
            key={k}
            label={contactKindLabels[k]}
            active={currentKind === k}
            onClick={() => applyKind(k)}
            data-kind={k}
          />
        ))}
        <Button variant="outline" size="xs" asChild className="ml-auto">
          <Link href="/contacts/new">
            <Plus className="size-3.5" />
            Add new
          </Link>
        </Button>
      </div>

      {currentKind === 'customer' ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Type:
          </span>
          <FilterChip
            label="All customers"
            active={currentSubtype === null}
            onClick={() => applySubtype(null)}
          />
          {CUSTOMER_SUBTYPES.map((t) => (
            <FilterChip
              key={t}
              label={customerTypeLabels[t]}
              active={currentSubtype === t}
              onClick={() => applySubtype(t)}
              data-type={t}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  ...rest
}: {
  label: string;
  active: boolean;
  onClick: () => void;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      variant={active ? 'secondary' : 'outline'}
      size="xs"
      onClick={onClick}
      aria-pressed={active}
      className={cn(active && 'ring-1 ring-primary/20')}
      {...rest}
    >
      {label}
    </Button>
  );
}
