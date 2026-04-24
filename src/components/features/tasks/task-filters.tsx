'use client';

/**
 * Top-of-list filter chips for the project task list:
 *   All / Mine / Unassigned / Blocked / Due This Week.
 *
 * Filtering is done client-side off the already-loaded task array — the
 * task set per job is small enough that paging through the server isn't
 * worth the complexity.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';

export type TaskFilter = 'all' | 'mine' | 'unassigned' | 'blocked' | 'due_week';

const filters: { key: TaskFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'due_week', label: 'Due This Week' },
];

export function TaskFilters({
  current,
  onChange,
}: {
  current: TaskFilter;
  onChange: (next: TaskFilter) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {filters.map((f) => (
        <button
          key={f.key}
          type="button"
          onClick={() => onChange(f.key)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
            current === f.key
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input bg-background text-muted-foreground hover:bg-accent',
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

export function useTaskFilter(initial: TaskFilter = 'all') {
  return useState<TaskFilter>(initial);
}
