'use client';

/**
 * Sub-tabs for /projects — All / Active / Complete.
 *
 * "Active" = planning + in_progress. "Complete" = complete. Cancelled projects
 * fall through to All and aren't given their own tab (rare; low-value UI).
 *
 * Follows PATTERNS.md §8: URL-param driven (`?view=`), router.replace to
 * avoid history pollution, native <select> on mobile.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const TABS = [
  { key: 'all', label: 'All' },
  { key: 'awaiting_approval', label: 'Awaiting approval' },
  { key: 'active', label: 'Active' },
  { key: 'complete', label: 'Complete' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

type Counts = {
  all: number;
  awaiting_approval: number;
  active: number;
  complete: number;
};

export function ProjectTabs({ counts }: { counts: Counts }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const current: TabKey =
    (TABS.find((t) => t.key === searchParams?.get('view'))?.key as TabKey) ?? 'all';

  function navigate(key: TabKey) {
    const params = new URLSearchParams(searchParams?.toString());
    if (key === 'all') params.delete('view');
    else params.set('view', key);
    const qs = params.toString();
    const base = pathname ?? '/';
    router.replace(qs ? `${base}?${qs}` : base, { scroll: false });
  }

  return (
    <>
      <select
        aria-label="Filter projects"
        value={current}
        onChange={(e) => navigate(e.target.value as TabKey)}
        className="block w-full rounded-md border bg-background px-3 py-2 text-sm md:hidden"
      >
        {TABS.map((t) => (
          <option key={t.key} value={t.key}>
            {t.label} ({counts[t.key]})
          </option>
        ))}
      </select>
      <div className="hidden flex-wrap gap-2 md:flex">
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
