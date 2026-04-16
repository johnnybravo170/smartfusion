/**
 * Reverse-chronological work log list, bucketed by day. Renders a sticky-ish
 * day heading (`Today` / `Yesterday` / formatted) above each group. This is
 * a pure server-friendly component: no client state needed when the URL
 * drives the filter/search params.
 */

import { MessageSquare } from 'lucide-react';
import type { WorklogRowWithRelated } from '@/lib/db/queries/worklog';
import { dayBucketLabel } from './relative-time';
import { WorklogEntry } from './worklog-entry';

function bucket(
  entries: WorklogRowWithRelated[],
): Array<{ label: string; items: WorklogRowWithRelated[] }> {
  const groups: Array<{ label: string; items: WorklogRowWithRelated[] }> = [];
  const now = new Date();
  let currentLabel: string | null = null;
  for (const entry of entries) {
    const label = dayBucketLabel(entry.created_at, now);
    if (label !== currentLabel) {
      groups.push({ label, items: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].items.push(entry);
  }
  return groups;
}

export function WorklogEmptyState({ variant = 'fresh' }: { variant?: 'fresh' | 'filtered' }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card p-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <MessageSquare className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">
          {variant === 'filtered' ? 'No entries match these filters.' : 'No entries yet.'}
        </p>
        <p className="text-xs text-muted-foreground">
          {variant === 'filtered'
            ? 'Try clearing the search or the type filter.'
            : 'System events and the notes you save will show up here.'}
        </p>
      </div>
    </div>
  );
}

export function WorklogList({
  entries,
  highlight,
}: {
  entries: WorklogRowWithRelated[];
  highlight?: string;
}) {
  if (entries.length === 0) {
    return <WorklogEmptyState variant={highlight ? 'filtered' : 'fresh'} />;
  }

  const groups = bucket(entries);

  return (
    <div className="flex flex-col gap-5">
      {groups.map((group) => (
        <section key={`${group.label}-${group.items[0].id}`} className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {group.label}
          </h2>
          <div className="flex flex-col gap-2">
            {group.items.map((entry) => (
              <WorklogEntry key={entry.id} entry={entry} highlight={highlight} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
