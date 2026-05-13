import Link from 'next/link';
import { relativeTime } from '@/lib/relative-time';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type HealthRow = {
  agent_id: string;
  slug: string;
  name: string;
  agent_type: 'routine' | 'cron' | 'managed';
  agent_status: 'active' | 'disabled' | 'archived';
  schedule: string | null;
  expected_max_gap_minutes: number | null;
  latest_started_at: string | null;
  latest_finished_at: string | null;
  latest_outcome: 'running' | 'success' | 'failure' | 'skipped' | null;
  latest_summary: string | null;
  latest_error: string | null;
  latest_evidence_at: string | null;
  evidence_24h: number | null;
  evidence_source: string | null;
  latest_activity_at: string | null;
  computed_status: 'ok' | 'stale' | 'broken' | 'never_run' | 'inactive';
};

const STATUS_TONE: Record<HealthRow['computed_status'], string> = {
  ok: 'bg-green-500/15 text-green-700 dark:text-green-400',
  stale: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  broken: 'bg-red-500/15 text-red-700 dark:text-red-400',
  never_run: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  inactive: 'bg-zinc-500/10 text-zinc-500',
};

const TYPE_BADGE: Record<HealthRow['agent_type'], string> = {
  routine: 'bg-purple-500/15 text-purple-700 dark:text-purple-300',
  cron: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  managed: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
};

export default async function AgentsPage() {
  const service = createServiceClient();
  const { data: agents } = await service
    .schema('ops')
    .from('agent_health')
    .select('*')
    .order('agent_status', { ascending: true })
    .order('name', { ascending: true });

  const rows = (agents ?? []) as HealthRow[];

  const counts = rows.reduce<Record<HealthRow['computed_status'], number>>(
    (acc, r) => {
      acc[r.computed_status] = (acc[r.computed_status] ?? 0) + 1;
      return acc;
    },
    { ok: 0, stale: 0, broken: 0, never_run: 0, inactive: 0 },
  );

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Every automated agent — Claude Code Routines, Vercel crons, Managed Agents — and their
            recent activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {(['broken', 'stale', 'ok', 'never_run', 'inactive'] as const).map((s) =>
            counts[s] > 0 ? (
              <span
                key={s}
                className={`rounded-full px-2 py-0.5 font-medium ${STATUS_TONE[s]}`}
                title={s}
              >
                {counts[s]} {s.replace('_', ' ')}
              </span>
            ) : null,
          )}
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--muted-foreground)]">
          No agents registered yet. Run <code>node scripts/seed-agents.mjs</code>.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => (
            <li key={a.agent_id}>
              <Link
                href={`/agents/${a.slug}`}
                className="block rounded-md border border-[var(--border)] p-3 transition hover:border-[var(--foreground)]"
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{a.name}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${TYPE_BADGE[a.agent_type]}`}
                      >
                        {a.agent_type}
                      </span>
                      {a.agent_status !== 'active' ? (
                        <span className="rounded bg-zinc-500/15 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500">
                          {a.agent_status}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 truncate text-xs text-[var(--muted-foreground)]">
                      <code className="font-mono">{a.slug}</code>
                      {a.schedule ? <> · {a.schedule}</> : null}
                      {a.latest_summary ? <> · {a.latest_summary}</> : null}
                      {a.evidence_24h && a.evidence_24h > 0 ? (
                        <>
                          {' · '}
                          <span title={a.evidence_source ?? ''}>
                            {a.evidence_24h} write{a.evidence_24h === 1 ? '' : 's'} in 24h
                          </span>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[a.computed_status]}`}
                    >
                      {a.computed_status.replace('_', ' ')}
                    </span>
                    <span
                      className="text-xs text-[var(--muted-foreground)]"
                      title={
                        a.latest_activity_at === a.latest_evidence_at && a.evidence_source
                          ? `derived from ${a.evidence_source}`
                          : a.latest_outcome
                            ? `recorded run · ${a.latest_outcome}`
                            : ''
                      }
                    >
                      {relativeTime(a.latest_activity_at ?? a.latest_started_at)}
                    </span>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
