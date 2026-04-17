import Link from 'next/link';
import { WorklogEntryTypeBadge } from '@/components/features/inbox/worklog-entry-type-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/date/format';
import type { RecentWorklogEntry } from '@/lib/db/queries/dashboard';
import type { WorklogEntryType } from '@/lib/validators/worklog';

export function RecentActivity({
  entries,
  timezone,
}: {
  entries: RecentWorklogEntry[];
  timezone: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Recent Activity</CardTitle>
        <Link href="/inbox" className="text-sm text-primary underline underline-offset-4">
          View all
        </Link>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-center gap-3 text-sm">
                <WorklogEntryTypeBadge entryType={entry.entry_type as WorklogEntryType} />
                <span className="truncate flex-1">{entry.title ?? 'Untitled entry'}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {formatRelativeTime(entry.created_at, { timezone })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
