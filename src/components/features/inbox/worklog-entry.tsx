'use client';

/**
 * Card-style row for a single work log entry. System/milestone entries are
 * read-only; only `note` entries surface a delete icon on hover.
 *
 * When `highlight` is provided we wrap case-insensitive substring matches in
 * `<mark>` for a simple search hit indicator. We deliberately avoid FTS
 * snippeting/ranking on the UI side — keeping this to a plain substring
 * scan keeps the markup predictable and the DOM small.
 */

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { type ReactNode, useMemo, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { WorklogRowWithRelated } from '@/lib/db/queries/worklog';
import { cn } from '@/lib/utils';
import { type WorklogRelatedType, worklogRelatedTypeLabels } from '@/lib/validators/worklog';
import { deleteWorklogNoteAction } from '@/server/actions/worklog';
import { formatAbsolute, formatRelativeTime } from './relative-time';
import { WorklogEntryTypeBadge } from './worklog-entry-type-badge';

function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightText(text: string | null, query: string | undefined): ReactNode {
  if (!text) return null;
  const needle = query?.trim();
  if (!needle) return text;
  try {
    const re = new RegExp(`(${escapeRegex(needle)})`, 'ig');
    const parts = text.split(re);
    return parts.map((part, i) =>
      re.test(part) && part.toLowerCase() === needle.toLowerCase() ? (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable rendering for static text
        <mark key={i} className="rounded-sm bg-amber-100 px-0.5 text-amber-900">
          {part}
        </mark>
      ) : (
        part
      ),
    );
  } catch {
    return text;
  }
}

export function WorklogEntry({
  entry,
  highlight,
}: {
  entry: WorklogRowWithRelated;
  highlight?: string;
}) {
  const timezone = useTenantTimezone();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const isNote = entry.entry_type === 'note';

  const titleNode = useMemo(() => highlightText(entry.title, highlight), [entry.title, highlight]);
  const bodyNode = useMemo(() => highlightText(entry.body, highlight), [entry.body, highlight]);

  function onDelete(e: React.MouseEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await deleteWorklogNoteAction(entry.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Note deleted.');
      router.refresh();
    });
  }

  return (
    <article
      data-slot="worklog-entry"
      data-entry-type={entry.entry_type}
      className={cn(
        'group flex flex-col gap-2 rounded-lg border bg-card p-3 transition-colors',
        'hover:border-foreground/20',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <WorklogEntryTypeBadge entryType={entry.entry_type} />
        {entry.related_type ? (
          <Badge variant="outline" className="text-xs">
            {worklogRelatedTypeLabels[entry.related_type as WorklogRelatedType]}
            {entry.related_name ? `: ${entry.related_name}` : ''}
          </Badge>
        ) : null}
        <span
          className="ml-auto text-xs text-muted-foreground"
          title={formatAbsolute(entry.created_at, timezone)}
        >
          {formatRelativeTime(entry.created_at, undefined, timezone)}
        </span>
        {isNote ? (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Delete note"
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                disabled={pending}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this note?</AlertDialogTitle>
                <AlertDialogDescription>
                  System-emitted entries can't be deleted; only this note will be removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  disabled={pending}
                  className="bg-destructive/10 text-destructive hover:bg-destructive/20"
                >
                  {pending ? 'Deleting…' : 'Delete'}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </header>

      {entry.title ? <h3 className="text-sm font-medium leading-snug">{titleNode}</h3> : null}
      {entry.body ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{bodyNode}</p>
      ) : null}
    </article>
  );
}
