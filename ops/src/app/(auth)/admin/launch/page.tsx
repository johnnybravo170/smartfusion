import Link from 'next/link';
import {
  getCriticalPath,
  getEpicHealth,
  getEta,
  getLaunchRollup,
  getNextForAssignee,
  getRecentlyShipped,
  getStuck,
  getVelocity,
} from '@/server/ops-services/launch';

// Server component; all data fetched in parallel.
export default async function LaunchPage() {
  const [rollup, velocity, critical, next, stuck, epics, shipped] = await Promise.all([
    getLaunchRollup(),
    getVelocity(28),
    getCriticalPath(5),
    getNextForAssignee('jonathan'),
    getStuck(3),
    getEpicHealth(),
    getRecentlyShipped(5),
  ]);

  const remaining = Math.max(0, rollup.totalPoints - rollup.donePoints);
  const eta = getEta(remaining, velocity.weeklyRate);

  return (
    <div className="space-y-10">
      {/* Row 1: hero */}
      <section className="text-center">
        <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
          HeyHenry V1
        </div>
        <div className="mt-1 text-7xl font-bold tracking-tight tabular-nums">
          {rollup.percentDone}% ready
        </div>
        <div className="mt-2 text-sm text-[var(--muted-foreground)]">
          {eta ? (
            <>
              ETA: ~{eta.weeks} weeks · ships around {eta.date}
              {velocity.source === 'git-seed' ? (
                <span className="ml-1 text-xs">(estimated from recent code activity)</span>
              ) : velocity.source === 'blended' ? (
                <span className="ml-1 text-xs">(kanban + code activity)</span>
              ) : null}
            </>
          ) : velocity.completedPoints === 0 ? (
            <>Velocity: no completed cards in last 28 days</>
          ) : (
            <>Remaining work: 0 pts</>
          )}
        </div>
        <div className="mt-2 text-xs text-[var(--muted-foreground)]">
          {rollup.remainingCardCount} of {rollup.blockerCardCount} cards remaining ·{' '}
          {rollup.donePoints}/{rollup.totalPoints} pts done
          {rollup.unsizedCards > 0 ? (
            <> · {rollup.unsizedCards} cards unsized (not counted)</>
          ) : null}
        </div>
      </section>

      {/* Row 2: action row */}
      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-md border border-[var(--border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            Next up for Jonathan
          </div>
          {next ? (
            <Link
              href={`/admin/kanban/dev/${next.id}`}
              className="mt-2 block hover:text-[var(--primary)]"
            >
              <div className="flex items-center gap-2">
                <PriorityDot priority={next.priority} />
                <div className="font-medium">{next.title}</div>
              </div>
              <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                {next.column_key} · {next.size_points ?? '?'} pts
              </div>
            </Link>
          ) : (
            <div className="mt-3 text-sm text-[var(--muted-foreground)]">Your queue is clear.</div>
          )}
        </div>

        <div className="rounded-md border border-[var(--border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            Stuck / blocking launch
          </div>
          {stuck.length > 0 ? (
            <ul className="mt-2 space-y-2">
              {stuck.map((s) => (
                <li key={s.id} className="text-sm">
                  <Link
                    href={`/admin/kanban/dev/${s.id}`}
                    className="flex items-baseline justify-between gap-3 hover:text-[var(--primary)]"
                  >
                    <span className="truncate">{s.title}</span>
                    <span className="text-xs text-[var(--muted-foreground)]">
                      {s.reason === 'doing_14d' ? `${s.daysStuck}d stuck` : 'unassigned · on path'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3 text-sm text-[var(--muted-foreground)]">Nothing stuck. Good.</div>
          )}
        </div>
      </section>

      {/* Row 3: critical path */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Critical path</h2>
        {critical.length > 0 ? (
          <ol className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {critical.map((c, i) => (
              <li key={c.id} className="px-4 py-3 text-sm">
                <Link
                  href={`/admin/kanban/dev/${c.id}`}
                  className="flex items-baseline justify-between gap-4 hover:text-[var(--primary)]"
                >
                  <div className="flex items-baseline gap-3 min-w-0">
                    <span className="tabular-nums text-[var(--muted-foreground)]">{i + 1}.</span>
                    <PriorityDot priority={c.priority} />
                    <span className="truncate">{c.title}</span>
                  </div>
                  <div className="shrink-0 text-xs text-[var(--muted-foreground)]">
                    {c.assignee ?? 'unassigned'} · {c.size_points ?? '?'} pts · {c.column_key}
                  </div>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            No launch-blocker cards on the critical path.
          </p>
        )}
      </section>

      {/* Row 4: epic health grid */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Epics</h2>
        {epics.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {epics.map((e) => (
              <Link
                key={e.slug}
                href={`/admin/kanban/dev?tag=epic:${e.slug}`}
                className="rounded-md border border-[var(--border)] p-3 hover:border-[var(--foreground)]"
              >
                <div className="flex items-center justify-between">
                  <div className="truncate font-mono text-xs">{e.slug}</div>
                  <HealthDot score={e.healthScore} />
                </div>
                <div className="mt-2 text-lg font-semibold tabular-nums">{e.percent}%</div>
                <div className="text-[10px] text-[var(--muted-foreground)]">
                  {e.donePoints}/{e.totalPoints} pts · {e.cardCount} cards
                </div>
                {(e.blockerCount > 0 || e.stuckCount > 0) && (
                  <div className="mt-1 text-[10px] text-amber-600">
                    {e.blockerCount > 0 ? `${e.blockerCount} blocked` : null}
                    {e.blockerCount > 0 && e.stuckCount > 0 ? ' · ' : null}
                    {e.stuckCount > 0 ? `${e.stuckCount} stuck` : null}
                  </div>
                )}
              </Link>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            No epics tagged yet. Tag cards with <code>epic:&lt;slug&gt;</code> to populate.
          </p>
        )}
      </section>

      {/* Row 5: recently shipped */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">Recently shipped</h2>
        {shipped.length > 0 ? (
          <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
            {shipped.map((s) => (
              <li key={s.id} className="px-4 py-2 text-sm">
                <Link
                  href={`/admin/kanban/dev/${s.id}`}
                  className="flex items-baseline justify-between gap-3 hover:text-[var(--primary)]"
                >
                  <span className="truncate">{s.title}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">
                    {s.size_points ?? '?'} pts · {relativeTime(s.done_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-6 text-center text-sm text-[var(--muted-foreground)]">
            Nothing shipped yet.
          </p>
        )}
      </section>
    </div>
  );
}

function PriorityDot({ priority }: { priority: number | null }) {
  const p = priority ?? 3;
  const color =
    p <= 1 ? 'bg-red-500' : p === 2 ? 'bg-orange-500' : p === 3 ? 'bg-yellow-500' : 'bg-zinc-400';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={`priority ${p}`} />;
}

function HealthDot({ score }: { score: number }) {
  const color = score >= 70 ? 'bg-emerald-500' : score >= 40 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} title={`health ${score}`} />
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 14) return `${d}d ago`;
  const w = Math.round(d / 7);
  return `${w}w ago`;
}
