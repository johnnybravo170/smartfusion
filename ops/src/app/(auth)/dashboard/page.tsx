import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase';
import { fmtAgo, fmtDateTime } from '@/lib/tz';
import { getVanitySummary } from '@/server/ops-services/git-stats';
import { getEta, getLaunchRollup, getVelocity } from '@/server/ops-services/launch';

type CapturedItem = {
  surface: 'worklog' | 'idea' | 'decision' | 'knowledge';
  id: string;
  title: string;
  created_at: string;
  href: string;
  userRating?: number | null;
};

const SURFACE_STYLES: Record<CapturedItem['surface'], { label: string; cls: string }> = {
  worklog: { label: 'Worklog', cls: 'bg-blue-500/10 text-blue-400' },
  idea: { label: 'Idea', cls: 'bg-amber-500/10 text-amber-400' },
  decision: { label: 'Decision', cls: 'bg-purple-500/10 text-purple-400' },
  knowledge: { label: 'Knowledge', cls: 'bg-emerald-500/10 text-emerald-400' },
};

export default async function DashboardPage() {
  const service = createServiceClient();
  const [launchRollup, launchVelocity, gitSummary] = await Promise.all([
    getLaunchRollup(),
    getVelocity(28),
    getVanitySummary(),
  ]);
  const launchRemaining = Math.max(0, launchRollup.totalPoints - launchRollup.donePoints);
  const launchEta = getEta(launchRemaining, launchVelocity.weeklyRate);
  const { data: recent } = await service
    .schema('ops')
    .from('worklog_entries')
    .select('id, title, actor_name, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(10);

  // Recently captured: mixed feed across worklog + ideas + decisions + knowledge.
  const [capWorklog, capIdeas, capDecisions, capKnowledge] = await Promise.all([
    service
      .schema('ops')
      .from('worklog_entries')
      .select('id, title, created_at')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(5),
    service
      .schema('ops')
      .from('ideas')
      .select('id, title, created_at, user_rating')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(5),
    service
      .schema('ops')
      .from('decisions')
      .select('id, title, created_at')
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(5),
    service
      .schema('ops')
      .from('knowledge_docs')
      .select('id, title, created_at')
      .order('created_at', { ascending: false })
      .limit(5),
  ]);

  const captured: CapturedItem[] = [
    ...(capWorklog.data ?? []).map((r) => ({
      surface: 'worklog' as const,
      id: r.id as string,
      title: (r.title as string) ?? '(no title)',
      created_at: r.created_at as string,
      href: '/worklog',
    })),
    ...(capIdeas.data ?? []).map((r) => ({
      surface: 'idea' as const,
      id: r.id as string,
      title: (r.title as string) ?? '(no title)',
      created_at: r.created_at as string,
      href: `/ideas/${r.id as string}`,
      userRating: (r.user_rating as number | null) ?? null,
    })),
    ...(capDecisions.data ?? []).map((r) => ({
      surface: 'decision' as const,
      id: r.id as string,
      title: (r.title as string) ?? '(no title)',
      created_at: r.created_at as string,
      href: `/decisions/${r.id as string}`,
    })),
    ...(capKnowledge.data ?? []).map((r) => ({
      surface: 'knowledge' as const,
      id: r.id as string,
      title: (r.title as string) ?? '(no title)',
      created_at: r.created_at as string,
      href: '/knowledge',
    })),
  ]
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, 5);

  const todayIso = new Date().toISOString().slice(0, 10);
  const [{ count: kanbanOpen }, { count: kanbanOverdue }, { count: kanbanJonathan }] =
    await Promise.all([
      service
        .schema('ops')
        .from('kanban_cards')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .neq('column_key', 'done'),
      service
        .schema('ops')
        .from('kanban_cards')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .is('done_at', null)
        .not('due_date', 'is', null)
        .lt('due_date', todayIso),
      service
        .schema('ops')
        .from('kanban_cards')
        .select('*', { count: 'exact', head: true })
        .is('archived_at', null)
        .neq('column_key', 'done')
        .eq('assignee', 'jonathan'),
    ]);

  const { count: keyCount } = await service
    .schema('ops')
    .from('api_keys')
    .select('*', { count: 'exact', head: true })
    .is('revoked_at', null);

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [{ data: mcpRows }, { count: activeTokenCount }] = await Promise.all([
    service
      .schema('ops')
      .from('audit_log')
      .select('status')
      .like('path', '/api/mcp/%')
      .gte('occurred_at', since24h),
    service
      .schema('ops')
      .from('oauth_tokens')
      .select('*', { count: 'exact', head: true })
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString()),
  ]);
  const mcpTotal = mcpRows?.length ?? 0;
  const mcpFailed = (mcpRows ?? []).filter((r) => (r.status as number) >= 400).length;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      {captured.length > 0 ? (
        <section>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
              Recently captured
            </span>
          </div>
          <ul className="flex gap-2 overflow-x-auto pb-1">
            {captured.map((c) => {
              const s = SURFACE_STYLES[c.surface];
              return (
                <li key={`${c.surface}:${c.id}`} className="shrink-0">
                  <Link
                    href={c.href}
                    className="flex h-[60px] w-64 items-center gap-2 rounded-md border border-[var(--border)] px-3 hover:border-[var(--foreground)]"
                  >
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${s.cls}`}
                    >
                      {s.label}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">{c.title}</span>
                      <span className="text-[10px] text-[var(--muted-foreground)]">
                        {fmtAgo(c.created_at)}
                      </span>
                    </span>
                    {c.userRating != null ? (
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${
                          c.userRating > 0
                            ? 'bg-emerald-500/10 text-emerald-400'
                            : 'bg-rose-500/10 text-rose-400'
                        }`}
                      >
                        {c.userRating > 0 ? `👍 +${c.userRating}` : `👎 ${c.userRating}`}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <Link
        href="/admin/launch"
        className="block rounded-md border border-[var(--border)] p-6 hover:border-[var(--foreground)]"
      >
        <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
          HeyHenry V1 launch
        </div>
        <div className="mt-1 flex items-baseline gap-3">
          <span className="text-5xl font-bold tabular-nums">{launchRollup.percentDone}%</span>
          <span className="text-sm text-[var(--muted-foreground)]">
            {launchEta
              ? `ETA ~${launchEta.weeks}w · ${launchEta.date}`
              : launchVelocity.completedPoints === 0
                ? 'no velocity (last 28d)'
                : 'complete'}
          </span>
        </div>
        <div className="mt-1 text-xs text-[var(--muted-foreground)]">
          {launchRollup.donePoints}/{launchRollup.totalPoints} pts · {launchRollup.blockerCardCount}{' '}
          launch-blocker cards
          {launchRollup.unsizedCards > 0 ? ` · ${launchRollup.unsizedCards} unsized` : ''}
        </div>
      </Link>

      {gitSummary.hasData ? (
        <Link
          href="/admin/stats"
          className="block rounded-md border border-[var(--border)] p-5 hover:border-[var(--foreground)]"
        >
          <div className="flex items-baseline justify-between">
            <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
              Lines of code shipped
            </div>
            <div className="text-xs text-[var(--muted-foreground)]">stats →</div>
          </div>
          <div className="mt-1 text-4xl font-semibold tabular-nums sm:text-5xl">
            {gitSummary.locNetAllTime.toLocaleString()}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <Stat label="commits today" value={gitSummary.commitsToday} />
            <Stat label="commits 7d" value={gitSummary.commitsThisWeek} />
            <Stat label="commits all time" value={gitSummary.commitsAllTime} />
            <Stat
              label="LOC net 7d"
              value={`${gitSummary.locNetThisWeek >= 0 ? '+' : ''}${gitSummary.locNetThisWeek.toLocaleString()}`}
            />
            <Stat label="active days / 30d" value={gitSummary.activeDaysThisMonth} />
          </div>
        </Link>
      ) : (
        <div className="rounded-md border border-[var(--border)] p-4 text-sm text-[var(--muted-foreground)]">
          No git stats yet. Seed with <code>scripts/git-stats-seed.mjs</code>.
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Active API keys" value={keyCount ?? 0} href="/admin/keys" />
        <Card label="Worklog entries" value={recent?.length ?? 0} href="/worklog" />
        <Card label="Audit log" value="view" href="/admin/audit" />
        <Card
          label="MCP (last 24h)"
          value={`${mcpTotal} calls · ${mcpFailed} failed · ${activeTokenCount ?? 0} tokens`}
          href="/admin/mcp"
        />
        <Card
          label="Kanban"
          value={`${kanbanOpen ?? 0} open · ${kanbanOverdue ?? 0} overdue · ${kanbanJonathan ?? 0} mine`}
          href="/admin/kanban"
        />
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent worklog</h2>
          <Link href="/worklog" className="text-xs text-[var(--muted-foreground)] hover:underline">
            All entries →
          </Link>
        </div>
        {recent && recent.length > 0 ? (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {recent.map((e) => (
              <li key={e.id} className="px-4 py-3 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="font-medium">{e.title ?? '(no title)'}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {e.actor_name} · {fmtDateTime(e.created_at)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
            No worklog entries yet.
          </p>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
      </div>
    </div>
  );
}

function Card({ label, value, href }: { label: string; value: number | string; href: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-[var(--border)] p-4 hover:border-[var(--foreground)]"
    >
      <div className="text-xs text-[var(--muted-foreground)]">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </Link>
  );
}
