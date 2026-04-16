/**
 * Inbox — Todos + Work log.
 *
 * Two-tab page driven by URL state: `?tab=todos` or `?tab=worklog`.
 * The server component fetches counts for both tabs (so the labels render
 * with numbers) and the list data for whichever tab is active. Search +
 * filter params only apply to the worklog tab but stay in the URL so
 * deep links work.
 *
 * Spec: PHASE_1_PLAN.md §8 Track E.
 */

import { AddNoteDialog } from '@/components/features/inbox/add-note-dialog';
import { InboxTabs } from '@/components/features/inbox/inbox-tabs';
import { TodoEmptyState } from '@/components/features/inbox/todo-empty-state';
import { TodoForm } from '@/components/features/inbox/todo-form';
import { TodoList } from '@/components/features/inbox/todo-list';
import { WorklogFilters } from '@/components/features/inbox/worklog-filters';
import { WorklogList } from '@/components/features/inbox/worklog-list';
import { countTodos, listTodos } from '@/lib/db/queries/todos';
import { countWorklog, listWorklog, searchWorklog } from '@/lib/db/queries/worklog';
import {
  type WorklogEntryType,
  type WorklogRelatedType,
  worklogEntryTypes,
  worklogRelatedTypes,
} from '@/lib/validators/worklog';

type RawSearchParams = Record<string, string | string[] | undefined>;

function parseString(value: string | string[] | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function parseEntryType(value: string | string[] | undefined): WorklogEntryType | undefined {
  if (typeof value !== 'string') return undefined;
  return (worklogEntryTypes as readonly string[]).includes(value)
    ? (value as WorklogEntryType)
    : undefined;
}

function parseRelatedType(value: string | string[] | undefined): WorklogRelatedType | undefined {
  if (typeof value !== 'string') return undefined;
  return (worklogRelatedTypes as readonly string[]).includes(value)
    ? (value as WorklogRelatedType)
    : undefined;
}

function parseTab(value: string | string[] | undefined): 'todos' | 'worklog' {
  if (value === 'worklog') return 'worklog';
  return 'todos';
}

export const metadata = {
  title: 'Inbox — Smartfusion',
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const tab = parseTab(sp.tab);
  const query = parseString(sp.q);
  const entryType = parseEntryType(sp.entry_type);
  const relatedType = parseRelatedType(sp.related_type);

  // Always fetch todo + worklog counts so the tab labels are accurate.
  const [todos, todoCount, worklogCountAll] = await Promise.all([
    listTodos({ limit: 200 }),
    countTodos(),
    countWorklog(),
  ]);

  // Work-log entries: only fetched when the tab is active (tiny optimisation;
  // the count is cheap so we always load it).
  let worklogEntries: Awaited<ReturnType<typeof listWorklog>> = [];
  if (tab === 'worklog') {
    if (query) {
      worklogEntries = await searchWorklog(query, 100);
      // Apply entry_type / related_type filters client-side for the search
      // path — FTS already narrowed the set.
      if (entryType) worklogEntries = worklogEntries.filter((e) => e.entry_type === entryType);
      if (relatedType)
        worklogEntries = worklogEntries.filter((e) => e.related_type === relatedType);
    } else {
      worklogEntries = await listWorklog({
        entry_type: entryType,
        related_type: relatedType,
        limit: 100,
      });
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">Your working memory and task list.</p>
      </header>

      <InboxTabs
        active={tab}
        todoCount={todoCount}
        worklogCount={worklogCountAll}
        todosContent={
          <>
            <TodoForm />
            {todos.length === 0 ? <TodoEmptyState /> : <TodoList todos={todos} />}
          </>
        }
        worklogContent={
          <>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <WorklogFilters
                defaultQuery={query}
                defaultEntryType={entryType}
                defaultRelatedType={relatedType}
              />
              <AddNoteDialog />
            </div>
            <WorklogList entries={worklogEntries} highlight={query || undefined} />
          </>
        }
      />
    </div>
  );
}
