/**
 * Inbox landing — redirects to the most active sub-tab.
 *
 * The inbox is now path-based (Intake / Todos / Work log are real
 * routes under `/inbox/*`). Anyone landing on bare `/inbox` is sent
 * to `/inbox/intake` since that's the most active surface for
 * everyday operator sessions.
 *
 * Old query-param state (`?tab=worklog`, etc) is honoured for one
 * cycle: routes through to the corresponding sub-route so existing
 * bookmarks don't break.
 */

import { redirect } from 'next/navigation';

type RawSearchParams = Record<string, string | string[] | undefined>;

export default async function InboxLandingPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : null;

  if (tab === 'worklog') {
    const params = new URLSearchParams();
    for (const k of ['q', 'entry_type', 'related_type'] as const) {
      const v = sp[k];
      if (typeof v === 'string') params.set(k, v);
    }
    const qs = params.toString();
    redirect(qs ? `/inbox/worklog?${qs}` : '/inbox/worklog');
  }
  if (tab === 'todos') {
    redirect('/inbox/todos');
  }

  redirect('/inbox/intake');
}
