import Link from 'next/link';
import { createServiceClient } from '@/lib/supabase';

export default async function DashboardPage() {
  const service = createServiceClient();
  const { data: recent } = await service
    .schema('ops')
    .from('worklog_entries')
    .select('id, title, actor_name, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(10);

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
                    {e.actor_name} · {new Date(e.created_at).toLocaleString()}
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
