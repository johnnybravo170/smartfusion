import Link from 'next/link';
import { listAdvisorStats, listAdvisors } from '@/server/ops-services/board';

export const dynamic = 'force-dynamic';

const ROLE_BADGE: Record<string, string> = {
  expert: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  challenger: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  chair: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
};

/**
 * Advisor leaderboard. Shows the per-advisor stats view from
 * `ops.advisor_stats` joined to advisor identity. Role-aware framing:
 * for challengers (Devil's Advocate), high overrule rate is expected
 * and the column header notes that.
 */
export default async function AdvisorLeaderboardPage() {
  const [stats, advisors] = await Promise.all([listAdvisorStats(), listAdvisors()]);
  const advisorById = new Map(advisors.map((a) => [a.id, a]));

  // Sort: experts first by credited rate, then challengers, then chair.
  const ordered = [...stats]
    .map((s) => ({ ...s, advisor: advisorById.get(s.advisor_id) }))
    .filter((r) => r.advisor)
    .sort((a, b) => {
      const roleOrder = { expert: 0, challenger: 1, chair: 2 } as const;
      const ra = roleOrder[a.role_kind];
      const rb = roleOrder[b.role_kind];
      if (ra !== rb) return ra - rb;
      const aRate = a.positions_taken > 0 ? a.credited / a.positions_taken : 0;
      const bRate = b.positions_taken > 0 ? b.credited / b.positions_taken : 0;
      return bRate - aRate;
    });

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
            <Link href="/board" className="hover:underline">
              ← Board
            </Link>
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Advisor records</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Cumulative performance across all sessions. The chair sees a different shape; the
            Devil's Advocate is <em>supposed to</em> have a high overrule rate — that's the role.
          </p>
        </div>
      </header>

      {ordered.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
          No data yet. Run a session and review it to populate.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[var(--border)]">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
                <th className="px-3 py-2">Advisor</th>
                <th className="px-3 py-2 text-right">Sessions</th>
                <th className="px-3 py-2 text-right">Positions</th>
                <th className="px-3 py-2 text-right">Credited</th>
                <th className="px-3 py-2 text-right">Overruled</th>
                <th className="px-3 py-2 text-right">Conceded</th>
                <th className="px-3 py-2 text-right">Avg rating</th>
                <th className="px-3 py-2 text-right">Outcomes</th>
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => {
                const a = r.advisor!;
                const creditRate =
                  r.positions_taken > 0
                    ? `${Math.round((r.credited / r.positions_taken) * 100)}%`
                    : '—';
                const overruleRate =
                  r.positions_taken > 0
                    ? `${Math.round((r.overruled / r.positions_taken) * 100)}%`
                    : '—';
                const concedeRate =
                  r.positions_taken > 0
                    ? `${Math.round((r.concessions / r.positions_taken) * 100)}%`
                    : '—';
                const avgRating =
                  r.avg_human_rating !== null && r.avg_human_rating !== undefined
                    ? `${Number(r.avg_human_rating).toFixed(2)}/5`
                    : '—';
                return (
                  <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                    <td className="px-3 py-2">
                      <Link
                        href={`/board/advisors/${a.id}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <span>{a.emoji}</span>
                        <span className="font-medium">{a.name}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${ROLE_BADGE[a.role_kind] ?? ''}`}
                        >
                          {a.role_kind}
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right">{r.sessions}</td>
                    <td className="px-3 py-2 text-right">{r.positions_taken}</td>
                    <td className="px-3 py-2 text-right">
                      {r.credited}{' '}
                      <span className="text-xs text-[var(--muted-foreground)]">({creditRate})</span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.overruled}{' '}
                      <span className="text-xs text-[var(--muted-foreground)]">
                        ({overruleRate})
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.concessions}{' '}
                      <span className="text-xs text-[var(--muted-foreground)]">
                        ({concedeRate})
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">{avgRating}</td>
                    <td className="px-3 py-2 text-right text-xs">
                      {r.proven_right_credit > 0 ||
                      r.proven_wrong_credit > 0 ||
                      r.overruled_but_right > 0 ? (
                        <span>
                          {r.proven_right_credit > 0 ? (
                            <span className="text-emerald-700 dark:text-emerald-400">
                              ✓{r.proven_right_credit}
                            </span>
                          ) : null}{' '}
                          {r.proven_wrong_credit > 0 ? (
                            <span className="text-red-700 dark:text-red-400">
                              ✗{r.proven_wrong_credit}
                            </span>
                          ) : null}{' '}
                          {r.overruled_but_right > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">
                              !overruled-but-right ×{r.overruled_but_right}
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="text-[var(--muted-foreground)]">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-[var(--muted-foreground)]">
        <strong>Credit rate</strong> = chair credited the advisor's reasoning / positions taken.{' '}
        <strong>Overrule rate</strong> = chair sided against. <strong>Concede rate</strong> ={' '}
        positions where the advisor shifted from their opening. <strong>Outcomes</strong> are
        retroactive marks on accepted decisions: ✓ proven right, ✗ proven wrong,{' '}
        <em>overruled-but-right</em> = chair overruled this advisor on a decision that was later
        proven wrong (i.e. they were right, you were wrong).
      </p>
    </div>
  );
}
