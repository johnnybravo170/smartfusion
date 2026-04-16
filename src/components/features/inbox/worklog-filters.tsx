'use client';

/**
 * Search + entry-type + related-type filters for the work log tab.
 *
 * State lives in the URL so the server component can render the correct
 * filtered list on refresh. Typing is debounced (300ms) so each keystroke
 * doesn't refetch. We snapshot `searchParams.toString()` into a stable
 * string so the effect only re-runs when the URL actually moves — matches
 * the pattern used by the Customers search bar.
 */

import { Search, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  worklogEntryTypeLabels,
  worklogEntryTypes,
  worklogRelatedTypeLabels,
  worklogRelatedTypes,
} from '@/lib/validators/worklog';

const ALL = '__all';
const DEBOUNCE_MS = 300;

export function WorklogFilters({
  defaultQuery = '',
  defaultEntryType,
  defaultRelatedType,
}: {
  defaultQuery?: string;
  defaultEntryType?: string;
  defaultRelatedType?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchId = useId();
  const [query, setQuery] = useState(defaultQuery);

  const paramsString = searchParams.toString();

  const push = useCallback(
    (nextParams: URLSearchParams) => {
      if (!nextParams.has('tab')) nextParams.set('tab', 'worklog');
      const qs = nextParams.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [pathname, router],
  );

  // Debounce the search query. On each keystroke we schedule a URL push;
  // the previous timer is cleared on re-render.
  useEffect(() => {
    const params = new URLSearchParams(paramsString);
    const current = params.get('q') ?? '';
    if (query === current) return;

    const id = setTimeout(() => {
      const next = new URLSearchParams(paramsString);
      if (query.trim()) next.set('q', query.trim());
      else next.delete('q');
      push(next);
    }, DEBOUNCE_MS);

    return () => clearTimeout(id);
  }, [query, paramsString, push]);

  function onEntryTypeChange(value: string) {
    const next = new URLSearchParams(paramsString);
    if (value === ALL) next.delete('entry_type');
    else next.set('entry_type', value);
    push(next);
  }

  function onRelatedTypeChange(value: string) {
    const next = new URLSearchParams(paramsString);
    if (value === ALL) next.delete('related_type');
    else next.set('related_type', value);
    push(next);
  }

  function clearAll() {
    setQuery('');
    const next = new URLSearchParams();
    next.set('tab', 'worklog');
    push(next);
  }

  const hasFilters =
    Boolean(query) ||
    (defaultEntryType && defaultEntryType !== ALL) ||
    (defaultRelatedType && defaultRelatedType !== ALL);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="relative min-w-[220px] flex-1">
        <Label htmlFor={searchId} className="sr-only">
          Search work log
        </Label>
        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={searchId}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search work log…"
          className="pl-7"
        />
      </div>

      <Select value={defaultEntryType ?? ALL} onValueChange={onEntryTypeChange}>
        <SelectTrigger className="w-[140px]" aria-label="Filter by entry type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {worklogEntryTypes.map((t) => (
            <SelectItem key={t} value={t}>
              {worklogEntryTypeLabels[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={defaultRelatedType ?? ALL} onValueChange={onRelatedTypeChange}>
        <SelectTrigger className="w-[160px]" aria-label="Filter by related type">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All subjects</SelectItem>
          {worklogRelatedTypes.map((t) => (
            <SelectItem key={t} value={t}>
              {worklogRelatedTypeLabels[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters ? (
        <Button variant="ghost" size="sm" onClick={clearAll}>
          <X className="size-3.5" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
