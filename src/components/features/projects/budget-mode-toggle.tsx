'use client';

/**
 * Editing / Executing mode toggle on the unified Budget page.
 *
 * Drives whether the operator is in scope-authoring posture (sections
 * expanded, "Send for approval" prominent, only Estimate column shown)
 * or status-tracking posture (sections collapsed by default, headline
 * numbers + diff chip up front, full Spent/Committed/Remaining columns).
 *
 * Defaults by lifecycle stage at the page level; this toggle lets the
 * operator override per-visit via a URL param. Visually prominent at
 * the very top of the Budget tab so the operator always knows which
 * posture they're in.
 *
 * URL param `?mode=editing` or `?mode=executing` — readable by both
 * server + client components on the Budget tab.
 */

import { Pencil, PlayCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTransition } from 'react';
import { cn } from '@/lib/utils';

export type BudgetMode = 'editing' | 'executing';

export function BudgetModeToggle({ currentMode }: { currentMode: BudgetMode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setMode(next: BudgetMode) {
    if (next === currentMode) return;
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('mode', next);
    startTransition(() => {
      router.replace(`?${sp.toString()}`, { scroll: false });
    });
  }

  const editingActive = currentMode === 'editing';
  const executingActive = currentMode === 'executing';

  return (
    <div
      role="tablist"
      aria-label="Budget mode"
      className="grid grid-cols-2 gap-1 rounded-lg border bg-card p-1"
    >
      <button
        type="button"
        role="tab"
        aria-selected={editingActive}
        onClick={() => setMode('editing')}
        disabled={pending}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition',
          editingActive
            ? 'bg-foreground text-background shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <Pencil className={cn('size-4', editingActive ? '' : 'opacity-70')} />
        <span>
          Editing
          <span
            className={cn(
              'ml-2 hidden text-[11px] font-normal sm:inline',
              editingActive ? 'opacity-80' : 'text-muted-foreground',
            )}
          >
            authoring
          </span>
        </span>
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={executingActive}
        onClick={() => setMode('executing')}
        disabled={pending}
        className={cn(
          'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium transition',
          executingActive
            ? 'bg-foreground text-background shadow-sm'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        <PlayCircle className={cn('size-4', executingActive ? '' : 'opacity-70')} />
        <span>
          Executing
          <span
            className={cn(
              'ml-2 hidden text-[11px] font-normal sm:inline',
              executingActive ? 'opacity-80' : 'text-muted-foreground',
            )}
          >
            tracking
          </span>
        </span>
      </button>
    </div>
  );
}
