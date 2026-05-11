'use client';

/**
 * Secondary sub-tabs inside the project Costs tab — Vendor quotes / POs /
 * Bills. Without this, the three sections stack vertically and the page
 * gets unwieldy once any of them has real volume.
 *
 * URL-param driven (`?sub=quotes|pos|bills`), `router.replace()` to avoid
 * history pollution, native `<select>` on mobile. Matches the tabs
 * pattern in PATTERNS.md §8.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'quotes', label: 'Vendor quotes' },
  { key: 'pos', label: 'POs' },
  { key: 'bills', label: 'Bills' },
  { key: 'expenses', label: 'Expenses' },
] as const;

export type CostsSubtabKey = (typeof TABS)[number]['key'];

export function CostsSubtabs({ counts }: { counts: Record<CostsSubtabKey, number> }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current: CostsSubtabKey =
    (TABS.find((t) => t.key === searchParams?.get('sub'))?.key as CostsSubtabKey) ?? 'quotes';

  function navigate(key: CostsSubtabKey) {
    const params = new URLSearchParams(searchParams?.toString());
    if (key === 'quotes') params.delete('sub');
    else params.set('sub', key);
    const qs = params.toString();
    const base = pathname ?? '/';
    router.replace(qs ? `${base}?${qs}` : base, { scroll: false });
  }

  return (
    <>
      <select
        aria-label="Filter costs"
        value={current}
        onChange={(e) => navigate(e.target.value as CostsSubtabKey)}
        className="mb-4 block w-full rounded-md border bg-background px-3 py-2 text-sm md:hidden"
      >
        {TABS.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label} ({counts[t.key]})
          </option>
        ))}
      </select>
      <div className="mb-4 hidden flex-wrap gap-2 md:flex">
        {TABS.map((t) => (
          <button
            type="button"
            key={t.key}
            onClick={() => navigate(t.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              current === t.key
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-muted bg-card text-muted-foreground hover:bg-muted/50',
            )}
          >
            {t.label}
            <Badge variant="secondary" className="h-4 min-w-[16px] px-1 text-[10px] leading-none">
              {counts[t.key]}
            </Badge>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Server-component helper: parse the current subtab from the page's
 * searchParams. Keeps the tab selection consistent between server
 * rendering and the client subtabs component.
 */
export function parseCostsSubtab(value: string | string[] | undefined): CostsSubtabKey {
  if (value === 'pos' || value === 'bills') return value;
  return 'quotes';
}
