import { FileText, Image as ImageIcon, NotebookPen, Receipt, Wallet } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatRelativeTime } from '@/lib/date/format';
import type { ActivityEvent, ActivityEventKind } from '@/lib/db/queries/activity-feed';
import { statusToneClass } from '@/lib/ui/status-tokens';

const KIND_ICON: Record<ActivityEventKind, typeof FileText> = {
  expense_created: Receipt,
  photo_uploaded: ImageIcon,
  document_uploaded: FileText,
  invoice_created: Wallet,
  invoice_sent: Wallet,
  invoice_paid: Wallet,
  worklog: NotebookPen,
};

// Tone per event kind in the unified palette.
// info = in-flight (uploads, sends), success = money in (paid), neutral = generic.
function toneFor(kind: ActivityEventKind): keyof typeof statusToneClass {
  switch (kind) {
    case 'invoice_paid':
      return 'success';
    case 'invoice_sent':
    case 'expense_created':
    case 'photo_uploaded':
    case 'document_uploaded':
      return 'info';
    default:
      return 'neutral';
  }
}

export function RecentActivity({
  entries,
  timezone,
}: {
  entries: ActivityEvent[];
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
            {entries.map((entry) => {
              const Icon = KIND_ICON[entry.kind] ?? NotebookPen;
              const tone = toneFor(entry.kind);
              return (
                <li key={entry.id}>
                  <Link
                    href={entry.edit_href}
                    className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1 text-sm hover:bg-muted"
                  >
                    <Badge
                      variant="outline"
                      className={`${statusToneClass[tone]} h-5 px-1.5 text-[10px] font-medium`}
                    >
                      <Icon className="size-3" />
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">
                      {entry.title}
                      {entry.project_name ? (
                        <span className="text-muted-foreground"> — {entry.project_name}</span>
                      ) : null}
                      {entry.is_group && entry.group_count ? (
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          (tap to view all)
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatRelativeTime(entry.created_at, { timezone })}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
