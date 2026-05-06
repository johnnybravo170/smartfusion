/**
 * Operator-side read-only view of the customer's idea board.
 *
 * Renders on the project Selections tab (above the operator-authored
 * selection list). Customer items are grouped by room, with an
 * "Unsorted" bucket for un-tagged items. Each unpromoted card carries
 * a "Promote" affordance that opens the SelectionFormDialog pre-filled
 * from the idea (see PromoteIdeaButton). Operators never delete the
 * customer's stuff — there is no edit/delete affordance here.
 */

import { Link as LinkIcon, StickyNote } from 'lucide-react';
import {
  PromotedBadge,
  PromoteIdeaButton,
} from '@/components/features/projects/promote-idea-button';
import type { IdeaBoardItem } from '@/server/actions/project-idea-board';

export function CustomerIdeasSection({
  projectId,
  items,
}: {
  projectId: string;
  items: IdeaBoardItem[];
}) {
  if (items.length === 0) return null;

  // Group by room. Items with no room go under an "Unsorted" header at
  // the bottom so room-tagged content reads first.
  const groups = new Map<string, IdeaBoardItem[]>();
  for (const item of items) {
    const key = item.room?.trim() || '';
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const orderedKeys = Array.from(groups.keys())
    .filter((k) => k !== '')
    .sort((a, b) => a.localeCompare(b));
  if (groups.has('')) orderedKeys.push('');

  return (
    <section
      aria-labelledby="customer-ideas-heading"
      className="rounded-lg border bg-blue-50/40 p-4"
    >
      <header className="mb-3 flex items-baseline justify-between gap-2">
        <div>
          <h2 id="customer-ideas-heading" className="text-base font-semibold">
            Customer ideas
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Inspiration the customer has dropped on their portal idea board. Promote any one into a
            project selection.
          </p>
        </div>
        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">
          {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </header>

      <div className="space-y-4">
        {orderedKeys.map((roomKey) => {
          const groupItems = groups.get(roomKey) ?? [];
          const label = roomKey || 'Unsorted';
          return (
            <div key={roomKey || '__unsorted__'}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {label}
              </h3>
              <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {groupItems.map((item) => (
                  <CustomerIdeaCard key={item.id} projectId={projectId} item={item} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CustomerIdeaCard({ projectId, item }: { projectId: string; item: IdeaBoardItem }) {
  const promoted = Boolean(item.promoted_to_selection_id);
  return (
    <li className="flex flex-col overflow-hidden rounded-md border bg-card">
      {item.kind === 'image' && item.image_url ? (
        // biome-ignore lint/performance/noImgElement: signed URL
        <img
          src={item.image_url}
          alt={item.title ?? ''}
          className="aspect-square w-full object-cover"
          loading="lazy"
        />
      ) : null}
      {item.kind === 'link' && item.thumbnail_url ? (
        // biome-ignore lint/performance/noImgElement: external thumbnail
        <img
          src={item.thumbnail_url}
          alt={item.title ?? ''}
          className="aspect-video w-full bg-muted object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      ) : null}
      {item.kind === 'link' && !item.thumbnail_url ? (
        <div className="flex aspect-video w-full items-center justify-center bg-muted">
          <LinkIcon className="size-6 text-muted-foreground" aria-hidden />
        </div>
      ) : null}
      {item.kind === 'note' ? (
        <div className="flex aspect-video w-full items-center justify-center bg-amber-50">
          <StickyNote className="size-6 text-amber-700" aria-hidden />
        </div>
      ) : null}

      <div className="flex-1 space-y-1 p-3">
        {item.title ? <p className="text-sm font-medium">{item.title}</p> : null}
        {item.kind === 'link' && item.source_url ? (
          <a
            href={item.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-primary hover:underline"
          >
            {safeHostname(item.source_url)}
          </a>
        ) : null}
        {item.notes ? (
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{item.notes}</p>
        ) : null}
        <div className="flex items-center justify-between gap-2 pt-1">
          {promoted ? <PromotedBadge /> : <span aria-hidden />}
          {!promoted ? <PromoteIdeaButton projectId={projectId} item={item} /> : null}
        </div>
      </div>
    </li>
  );
}

function safeHostname(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}
