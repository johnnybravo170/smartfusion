'use client';

/**
 * Client wrapper for the Inbox tabs. The active tab is driven by a `tab`
 * search param so refreshes and deep links land on the same view. We use
 * `router.replace` rather than `push` so rapid flips don't pollute the
 * browser history.
 */

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCallback } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type InboxTabValue = 'todos' | 'worklog';

export function InboxTabs({
  active,
  todoCount,
  worklogCount,
  todosContent,
  worklogContent,
}: {
  active: InboxTabValue;
  todoCount: number;
  worklogCount: number;
  todosContent: ReactNode;
  worklogContent: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const onChange = useCallback(
    (value: string) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      if (value === 'todos') {
        next.delete('tab');
      } else {
        next.set('tab', value);
      }
      // Reset work-log-only params when leaving worklog.
      if (value === 'todos') {
        next.delete('q');
        next.delete('entry_type');
        next.delete('related_type');
      }
      const qs = next.toString();
      const base = pathname ?? '/';
      router.replace(qs ? `${base}?${qs}` : base);
    },
    [router, pathname, searchParams],
  );

  return (
    <Tabs value={active} onValueChange={onChange} className="w-full">
      <TabsList aria-label="Inbox tabs">
        <TabsTrigger value="todos">Todos ({todoCount})</TabsTrigger>
        <TabsTrigger value="worklog">Work log ({worklogCount})</TabsTrigger>
      </TabsList>
      <TabsContent value="todos" className="mt-4 flex flex-col gap-4">
        {todosContent}
      </TabsContent>
      <TabsContent value="worklog" className="mt-4 flex flex-col gap-4">
        {worklogContent}
      </TabsContent>
    </Tabs>
  );
}
