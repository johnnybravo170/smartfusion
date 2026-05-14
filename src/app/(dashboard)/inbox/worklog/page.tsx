/**
 * Inbox → Work log sub-route. Layout renders the shared header + tab
 * nav. This page handles search + filter URL params and the list.
 */

import { AddNoteDialog } from '@/components/features/inbox/add-note-dialog';
import { WorklogFilters } from '@/components/features/inbox/worklog-filters';
import { WorklogList } from '@/components/features/inbox/worklog-list';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listWorklog, searchWorklog } from '@/lib/db/queries/worklog';
import {
  type WorklogEntryType,
  type WorklogRelatedType,
  worklogEntryTypes,
  worklogRelatedTypes,
} from '@/lib/validators/worklog';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseString(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

function parseEntryType(v: string | string[] | undefined): WorklogEntryType | undefined {
  if (typeof v !== 'string') return undefined;
  return (worklogEntryTypes as readonly string[]).includes(v) ? (v as WorklogEntryType) : undefined;
}

function parseRelatedType(v: string | string[] | undefined): WorklogRelatedType | undefined {
  if (typeof v !== 'string') return undefined;
  return (worklogRelatedTypes as readonly string[]).includes(v)
    ? (v as WorklogRelatedType)
    : undefined;
}

export const metadata = { title: 'Work log — Inbox — HeyHenry' };

export default async function InboxWorklogPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const query = parseString(sp.q);
  const entryType = parseEntryType(sp.entry_type);
  const relatedType = parseRelatedType(sp.related_type);

  const tenant = await getCurrentTenant();
  const timezone = tenant?.timezone || 'America/Vancouver';

  let entries: Awaited<ReturnType<typeof listWorklog>> = [];
  if (query) {
    entries = await searchWorklog(query, 100);
    if (entryType) entries = entries.filter((e) => e.entry_type === entryType);
    if (relatedType) entries = entries.filter((e) => e.related_type === relatedType);
  } else {
    entries = await listWorklog({
      entry_type: entryType,
      related_type: relatedType,
      limit: 100,
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <WorklogFilters
          defaultQuery={query}
          defaultEntryType={entryType}
          defaultRelatedType={relatedType}
        />
        <AddNoteDialog />
      </div>
      <WorklogList entries={entries} highlight={query || undefined} timezone={timezone} />
    </>
  );
}
