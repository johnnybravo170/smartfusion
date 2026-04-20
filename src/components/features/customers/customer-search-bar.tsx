'use client';

/**
 * Search + type filter for the customer list.
 *
 * State lives in the URL (`?q=…&type=…`) so links are shareable and the
 * browser back button works. Typing is debounced (300ms) so we don't thrash
 * the server on every keystroke.
 */

import { Plus, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { type CustomerType, customerTypeLabels, customerTypes } from '@/lib/validators/customer';

const DEBOUNCE_MS = 300;

export function CustomerSearchBar({ defaultQuery }: { defaultQuery: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(defaultQuery);
  const [, startTransition] = useTransition();

  const currentType = useMemo(() => {
    const raw = searchParams.get('type');
    if (!raw) return null;
    return (customerTypes as readonly string[]).includes(raw) ? (raw as CustomerType) : null;
  }, [searchParams]);

  // Snapshot the stable string form so the effect runs only when the query
  // changes or the URL actually moved (not on every React re-render).
  const paramsString = searchParams.toString();

  // Debounce the search query. Pushing a new URL cancels on each keystroke.
  useEffect(() => {
    const params = new URLSearchParams(paramsString);
    const current = params.get('q') ?? '';
    if (query === current) return;

    const id = setTimeout(() => {
      if (query) params.set('q', query);
      else params.delete('q');
      startTransition(() => {
        router.replace(`/customers?${params.toString()}`);
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(id);
  }, [query, paramsString, router]);

  function applyType(next: CustomerType | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set('type', next);
    else params.delete('type');
    startTransition(() => {
      router.replace(`/customers?${params.toString()}`);
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
          aria-label="Search customers"
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
          Filter:
        </span>
        <FilterChip label="All" active={currentType === null} onClick={() => applyType(null)} />
        {customerTypes.map((t) => (
          <FilterChip
            key={t}
            label={customerTypeLabels[t]}
            active={currentType === t}
            onClick={() => applyType(t)}
            data-type={t}
          />
        ))}
        <Button variant="outline" size="xs" asChild className="ml-auto">
          <Link href="/customers/new">
            <Plus className="size-3.5" />
            Add new
          </Link>
        </Button>
      </div>
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
