'use client';

/**
 * Pipeline sub-tabs for /quotes — Draft / Sent / Declined, plus "All".
 *
 * Follows PATTERNS.md §8: `router.replace()` to avoid history pollution,
 * URL-param driven via `?status=`, mobile uses a native `<select>` instead
 * of horizontal button scroll.
 *
 * Accepted quotes live under Projects (separate page); expired quotes fall
 * through to the "All" tab since they're rare.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import type { QuoteStatusCounts } from '@/lib/db/queries/quotes';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'rejected', label: 'Declined' },
  { key: 'expired', label: 'Expired' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export function PipelineTabs({ counts }: { counts: QuoteStatusCounts }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current: TabKey =
    (TABS.find((t) => t.key === searchParams.get('status'))?.key as TabKey) ?? 'all';

  function countFor(key: TabKey): number {
    if (key === 'all') return counts.all;
    return counts[key];
  }

  function navigate(key: TabKey) {
    const params = new URLSearchParams(searchParams.toString());
    if (key === 'all') params.delete('status');
    else params.set('status', key);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <>
      {/* Mobile: native select. Desktop: button row. */}
      <select
        aria-label="Filter pipeline"
        value={current}
        onChange={(e) => navigate(e.target.value as TabKey)}
        className="block w-full rounded-md border bg-background px-3 py-2 text-sm md:hidden"
      >
        {TABS.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label} ({countFor(t.key)})
          </option>
        ))}
      </select>
      <div className="hidden flex-wrap gap-2 md:flex">
        {TABS.map((t) => {
          const count = countFor(t.key);
          const active = current === t.key;
          return (
            <button
              type="button"
              key={t.key}
              onClick={() => navigate(t.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-muted bg-card text-muted-foreground hover:bg-muted/50',
              )}
            >
              {t.label}
              <Badge variant="secondary" className="h-4 min-w-[16px] px-1 text-[10px] leading-none">
                {count}
              </Badge>
            </button>
          );
        })}
      </div>
    </>
  );
}
