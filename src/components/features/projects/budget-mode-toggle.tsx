'use client';

/**
 * Editing / Executing mode toggle on the unified Budget page.
 *
 * Drives whether the operator is in scope-authoring posture (sections
 * expanded, Send for approval prominent) or status-tracking posture
 * (sections collapsed by default, headline numbers + diff chip up
 * front). Defaults by lifecycle stage at the page level; this toggle
 * lets the operator override per-visit via a URL param.
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

  return (
    <div className="inline-flex shrink-0 rounded-md border bg-card p-0.5 text-xs">
      <button
        type="button"
        onClick={() => setMode('editing')}
        disabled={pending}
        className={cn(
          'inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition',
          currentMode === 'editing'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        <Pencil className="size-3" />
        Editing
      </button>
      <button
        type="button"
        onClick={() => setMode('executing')}
        disabled={pending}
        className={cn(
          'inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition',
          currentMode === 'executing'
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:bg-muted',
        )}
      >
        <PlayCircle className="size-3" />
        Executing
      </button>
    </div>
  );
}
