import Link from 'next/link';
import { notFound } from 'next/navigation';
import { fmtDate } from '@/lib/tz';
import {
  getAdvisor,
  getAdvisorStat,
  listDecisionsForAdvisor,
  listRatedMessagesForAdvisor,
  listRecentPositionsForAdvisor,
} from '@/server/ops-services/board';
import { Markdown } from '../../markdown';

export const dynamic = 'force-dynamic';

const ROLE_BADGE: Record<string, string> = {
  expert: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  challenger: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  chair: 'bg-purple-500/10 text-purple-700 dark:text-purple-300',
};

export default async function AdvisorRecordPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const advisor = await getAdvisor(id);
  if (!advisor) notFound();

  const [stat, positions, ratedMessages, decisions] = await Promise.all([
    getAdvisorStat(id),
    listRecentPositionsForAdvisor(id, 30),
    listRatedMessagesForAdvisor(id, { limit: 30 }),
    listDecisionsForAdvisor(id, { limit: 30, kind: 'both' }),
  ]);

  const credited = decisions.filter((d) => d.link_kind === 'credited');
  const overruled = decisions.filter((d) => d.link_kind === 'overruled');

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
          <Link href="/board/advisors" className="hover:underline">
            ← Records
          </Link>
        </p>
        <div className="mt-1 flex items-center gap-3">
          <span className="text-2xl">{advisor.emoji}</span>
          <h1 className="text-2xl font-semibold tracking-tight">{advisor.name}</h1>
          <span
            className={`rounded px-2 py-0.5 text-xs uppercase tracking-wide ${ROLE_BADGE[advisor.role_kind] ?? ''}`}
          >
            {advisor.role_kind}
          </span>
        </div>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">{advisor.title}</p>
        {advisor.description ? (
          <p className="mt-2 max-w-3xl text-sm">{advisor.description}</p>
        ) : null}
        {advisor.expertise.length > 0 ? (
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">
            Expertise: {advisor.expertise.join(', ')}
          </p>
        ) : null}
      </header>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Numbers
        </h2>
        {stat ? (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <Stat label="Sessions" value={stat.sessions} />
            <Stat label="Positions taken" value={stat.positions_taken} />
            <Stat
              label="Credited"
              value={stat.credited}
              hint={
                stat.positions_taken > 0
                  ? `${Math.round((stat.credited / stat.positions_taken) * 100)}%`
                  : null
              }
            />
            <Stat
              label="Overruled"
              value={stat.overruled}
              hint={
                stat.positions_taken > 0
                  ? `${Math.round((stat.overruled / stat.positions_taken) * 100)}%`
                  : null
              }
            />
            <Stat
              label="Conceded"
              value={stat.concessions}
              hint={
                stat.positions_taken > 0
                  ? `${Math.round((stat.concessions / stat.positions_taken) * 100)}%`
                  : null
              }
            />
            <Stat
              label="Avg rating"
              value={
                stat.avg_human_rating !== null && stat.avg_human_rating !== undefined
                  ? `${Number(stat.avg_human_rating).toFixed(2)}/5`
                  : '—'
              }
            />
            <Stat
              label="Proven right"
              value={stat.proven_right_credit}
              accent={stat.proven_right_credit > 0 ? 'emerald' : null}
            />
            <Stat
              label="Proven wrong"
              value={stat.proven_wrong_credit}
              accent={stat.proven_wrong_credit > 0 ? 'red' : null}
            />
          </div>
        ) : (
          <p className="text-sm text-[var(--muted-foreground)]">No data yet.</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Recent positions ({positions.length})
        </h2>
        {positions.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">No positions yet.</p>
        ) : (
          <ul className="space-y-2">
            {positions.map((p) => (
              <li key={p.id} className="rounded-md border border-[var(--border)] p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/board/sessions/${p.session_id}`}
                      className="text-sm font-medium hover:underline"
                    >
                      {p.session_title}
                    </Link>
                    {p.crux_label ? (
                      <p className="text-xs text-[var(--muted-foreground)]">Crux: {p.crux_label}</p>
                    ) : (
                      <p className="text-xs text-[var(--muted-foreground)]">Overall position</p>
                    )}
                    <p className="mt-1">{p.stance}</p>
                  </div>
                  <div className="text-right text-xs text-[var(--muted-foreground)]">
                    <div>{p.confidence}/5</div>
                    {p.shifted_from_opening ? <div className="text-amber-600">shifted</div> : null}
                    <div>{fmtDate(p.session_created_at)}</div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Credited on ({credited.length})
          </h2>
          {credited.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No credited decisions yet.</p>
          ) : (
            <ul className="space-y-2">
              {credited.map((d) => (
                <li
                  key={`${d.decision_id}-c`}
                  className="rounded-md border border-emerald-200 bg-emerald-50/40 p-3 text-sm dark:border-emerald-900 dark:bg-emerald-950/20"
                >
                  <Link
                    href={`/board/sessions/${d.session_id}`}
                    className="font-medium hover:underline"
                  >
                    {d.session_title}
                  </Link>
                  <p className="mt-1 line-clamp-3 text-[var(--muted-foreground)]">
                    {d.decision_text}
                  </p>
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {d.status} ·{' '}
                    {d.outcome !== 'pending' ? `outcome: ${d.outcome}` : 'outcome pending'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Overruled on ({overruled.length})
          </h2>
          {overruled.length === 0 ? (
            <p className="text-sm text-[var(--muted-foreground)]">No overruled decisions yet.</p>
          ) : (
            <ul className="space-y-2">
              {overruled.map((d) => (
                <li
                  key={`${d.decision_id}-o`}
                  className="rounded-md border border-amber-200 bg-amber-50/40 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/20"
                >
                  <Link
                    href={`/board/sessions/${d.session_id}`}
                    className="font-medium hover:underline"
                  >
                    {d.session_title}
                  </Link>
                  <p className="mt-1 line-clamp-3 text-[var(--muted-foreground)]">
                    {d.decision_text}
                  </p>
                  {d.overrule_reason ? (
                    <p className="mt-1 text-xs italic">Chair: "{d.overrule_reason}"</p>
                  ) : null}
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {d.status} ·{' '}
                    {d.outcome !== 'pending' ? `outcome: ${d.outcome}` : 'outcome pending'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Recent rated messages ({ratedMessages.length})
        </h2>
        {ratedMessages.length === 0 ? (
          <p className="text-sm text-[var(--muted-foreground)]">
            No per-message ratings yet. Rate individual advisor messages on a session page.
          </p>
        ) : (
          <ul className="space-y-2">
            {ratedMessages.map((m) => (
              <li
                key={m.message_id}
                className="rounded-md border border-[var(--border)] p-3 text-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/board/sessions/${m.session_id}`}
                      className="text-xs font-medium hover:underline"
                    >
                      {m.session_title}
                    </Link>
                    <span className="ml-2 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      {m.turn_kind.replace('_', ' ')}
                    </span>
                    <div className="mt-1">
                      <Markdown>{m.content_preview}</Markdown>
                    </div>
                    {m.review_note ? (
                      <p className="mt-1 text-xs italic text-[var(--muted-foreground)]">
                        Note: "{m.review_note}"
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right text-amber-500">{'★'.repeat(m.advisor_rating)}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number | string;
  hint?: string | null;
  accent?: 'emerald' | 'red' | null;
}) {
  const accentClass =
    accent === 'emerald'
      ? 'text-emerald-700 dark:text-emerald-400'
      : accent === 'red'
        ? 'text-red-700 dark:text-red-400'
        : '';
  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <p className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${accentClass}`}>{value}</p>
      {hint ? <p className="text-xs text-[var(--muted-foreground)]">{hint}</p> : null}
    </div>
  );
}
