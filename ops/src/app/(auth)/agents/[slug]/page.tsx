import Link from 'next/link';
import { notFound } from 'next/navigation';
import { relativeTime } from '@/lib/relative-time';
import { createServiceClient } from '@/lib/supabase';
import { fmtDateTime } from '@/lib/tz';

export const dynamic = 'force-dynamic';

type Run = {
  id: string;
  started_at: string;
  finished_at: string | null;
  outcome: 'running' | 'success' | 'failure' | 'skipped';
  trigger: 'schedule' | 'manual' | 'webhook' | 'backfill';
  items_scanned: number | null;
  items_acted: number | null;
  summary: string | null;
  payload: unknown;
  error: string | null;
};

const OUTCOME_TONE: Record<Run['outcome'], string> = {
  success: 'bg-green-500/15 text-green-700 dark:text-green-400',
  skipped: 'bg-zinc-500/15 text-zinc-600 dark:text-zinc-300',
  failure: 'bg-red-500/15 text-red-700 dark:text-red-400',
  running: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
};

export default async function AgentDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const service = createServiceClient();

  const { data: agent } = await service
    .schema('ops')
    .from('agents')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (!agent) notFound();

  const { data: health } = await service
    .schema('ops')
    .from('agent_health')
    .select('latest_started_at, latest_outcome, computed_status')
    .eq('slug', slug)
    .maybeSingle();

  const { data: runs } = await service
    .schema('ops')
    .from('agent_runs')
    .select(
      'id, started_at, finished_at, outcome, trigger, items_scanned, items_acted, summary, payload, error',
    )
    .eq('agent_id', agent.id)
    .order('started_at', { ascending: false })
    .limit(50);

  const totals = (runs ?? []).reduce<Record<Run['outcome'], number>>(
    (acc, r) => {
      acc[r.outcome as Run['outcome']] = (acc[r.outcome as Run['outcome']] ?? 0) + 1;
      return acc;
    },
    { success: 0, skipped: 0, failure: 0, running: 0 },
  );

  return (
    <div className="space-y-6">
      <Link href="/agents" className="text-xs text-[var(--muted-foreground)] hover:underline">
        ← All agents
      </Link>

      <header>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
          <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase">
            {agent.agent_type}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs text-[var(--muted-foreground)]">{agent.slug}</p>
        {agent.description ? (
          <p className="mt-3 max-w-3xl text-sm text-[var(--muted-foreground)]">
            {agent.description}
          </p>
        ) : null}
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <Field label="Schedule" value={agent.schedule ?? '—'} />
          <Field label="Owner" value={agent.owner ?? '—'} />
          <Field label="Status" value={agent.status} />
          <Field
            label="Health"
            value={
              <span className="font-medium">
                {(health?.computed_status as string) ?? 'unknown'}
                {health?.latest_started_at ? (
                  <> · {relativeTime(health.latest_started_at as string)}</>
                ) : null}
              </span>
            }
          />
        </dl>
        {agent.external_link ? (
          <a
            href={agent.external_link}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-xs text-blue-600 hover:underline dark:text-blue-400"
          >
            ↗ Open external surface
          </a>
        ) : null}
      </header>

      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Recent runs</h2>
          <div className="flex gap-2 text-[11px]">
            {(['success', 'skipped', 'failure', 'running'] as const).map((o) =>
              totals[o] > 0 ? (
                <span key={o} className={`rounded-full px-2 py-0.5 ${OUTCOME_TONE[o]}`}>
                  {totals[o]} {o}
                </span>
              ) : null,
            )}
          </div>
        </div>

        {!runs || runs.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">No runs recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {(runs as Run[]).map((r) => (
              <li key={r.id} className="rounded-md border border-[var(--border)] p-3 text-sm">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${OUTCOME_TONE[r.outcome]}`}
                      >
                        {r.outcome}
                      </span>
                      <span className="text-[10px] uppercase text-[var(--muted-foreground)]">
                        {r.trigger}
                      </span>
                      <span className="text-xs text-[var(--muted-foreground)]">
                        {fmtDateTime(r.started_at)} · {relativeTime(r.started_at)}
                      </span>
                      {typeof r.items_scanned === 'number' || typeof r.items_acted === 'number' ? (
                        <span className="text-xs text-[var(--muted-foreground)]">
                          · {r.items_acted ?? 0}/{r.items_scanned ?? '?'} acted
                        </span>
                      ) : null}
                    </div>
                    {r.summary ? <p className="mt-1 text-sm">{r.summary}</p> : null}
                    {r.error ? (
                      <pre className="mt-1 whitespace-pre-wrap rounded bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-400">
                        {r.error}
                      </pre>
                    ) : null}
                  </div>
                </div>
                {r.payload ? (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-[var(--muted-foreground)]">
                      payload
                    </summary>
                    <pre className="mt-2 max-h-64 overflow-auto rounded bg-[var(--muted)] p-2 font-mono">
                      {JSON.stringify(r.payload, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
        {label}
      </dt>
      <dd className="mt-0.5">{value}</dd>
    </div>
  );
}
