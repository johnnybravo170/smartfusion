/**
 * Inbox layout — shared header + sub-tab nav across Todos / Work log / Intake.
 *
 * Each tab is its own real route (path-based, not `?tab=` query param)
 * so URLs are stable for bookmarks, deep links from notifications, and
 * mobile share sheets. Counts shown in tab labels are fetched in the
 * layout so they're consistent across tabs without per-page duplication.
 */

import type { ReactNode } from 'react';
import { InboxTabNav } from '@/components/features/inbox/inbox-tab-nav';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { countTodos } from '@/lib/db/queries/todos';
import { countWorklog } from '@/lib/db/queries/worklog';
import { createClient } from '@/lib/supabase/server';

async function getIntakeReviewCount(): Promise<number> {
  const tenant = await getCurrentTenant();
  if (!tenant) return 0;
  const supabase = await createClient();
  const { count } = await supabase
    .from('intake_drafts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenant.id)
    .in('disposition', ['pending_review', 'error']);
  return count ?? 0;
}

export const metadata = { title: 'Inbox — HeyHenry' };

export default async function InboxLayout({ children }: { children: ReactNode }) {
  const [intakeCount, todoCount, worklogCount] = await Promise.all([
    getIntakeReviewCount(),
    countTodos(),
    countWorklog(),
  ]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Henry's intake activity, your todos, and the work log — all in one place.
        </p>
      </header>

      <InboxTabNav
        tabs={[
          { key: 'intake', label: 'Intake', href: '/inbox/intake', count: intakeCount },
          { key: 'todos', label: 'Todos', href: '/inbox/todos', count: todoCount },
          { key: 'worklog', label: 'Work log', href: '/inbox/worklog', count: worklogCount },
        ]}
      />

      {children}
    </div>
  );
}
