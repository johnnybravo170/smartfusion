import Link from 'next/link';
import { fmtDate } from '@/lib/tz';
import { listAdvisors, listDecisionsForOutcomeQueue } from '@/server/ops-services/board';
import { Markdown } from '../markdown';
import { OutcomeMarker } from './outcome-marker';

export const dynamic = 'force-dynamic';

const DEFAULT_MIN_AGE_DAYS = 0;

const OUTCOME_DOT: Record<string, string> = {
  pending: 'bg-zinc-400',
  proven_right: 'bg-emerald-500',
  proven_wrong: 'bg-red-500',
  obsolete: 'bg-zinc-500',
};

const OUTCOME_LABEL: Record<string, string> = {
  pending: 'Pending',
  proven_right: 'Proven right',
  proven_wrong: 'Proven wrong',
  obsolete: 'Obsolete',
};

export default async function DecisionsQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; age?: string }>;
}) {
  const sp = await searchParams;
  const filter = sp.filter ?? 'pending';
  const ageDays = Number(sp.age ?? DEFAULT_MIN_AGE_DAYS);

  const [decisions, advisors] = await Promise.all([
    listDecisionsForOutcomeQueue({
      only_pending: filter === 'pending',
      min_age_days: Number.isFinite(ageDays) && ageDays > 0 ? ageDays : undefined,
      limit: 200,
    }),
    listAdvisors(),
  ]);
  const advisorById = new Map(advisors.map((a) => [a.id, a]));

  const counts = {
    total: decisions.length,
    pending: decisions.filter((d) => d.outcome === 'pending').length,
    right: decisions.filter((d) => d.outcome === 'proven_right').length,
    wrong: decisions.filter((d) => d.outcome === 'proven_wrong').length,
    obsolete: decisions.filter((d) => d.outcome === 'obsolete').length,
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
          <Link href="/board" className="hover:underline">
            ← Board
          </Link>
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Decision outcomes</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--muted-foreground)]">
          Once a decision has played out, mark it. The advisor records page picks up{' '}
          <em>proven_right_credit</em> and <em>proven_wrong_credit</em>; the chair sees the pattern
          on its next session and recalibrates. This is the long-horizon signal that makes the
          system actually compound.
        </p>
      </header>

      <section className="flex flex-wrap items-center gap-2 text-xs">
        <FilterLink current={filter} value="pending" age={ageDays}>
          Pending ({counts.pending})
        </FilterLink>
        <FilterLink current={filter} value="all" age={ageDays}>
          All ({counts.total})
        </FilterLink>
        <span className="ml-3 text-[var(--muted-foreground)]">Min age:</span>
        <AgeLink current={ageDays} value={0} filter={filter}>
          Any
        </AgeLink>
        <AgeLink current={ageDays} value={7} filter={filter}>
          7d+
        </AgeLink>
        <AgeLink current={ageDays} value={30} filter={filter}>
          30d+
        </AgeLink>
        <AgeLink current={ageDays} value={90} filter={filter}>
          90d+
        </AgeLink>
      </section>

      {decisions.length === 0 ? (
        <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
          {filter === 'pending'
            ? 'No accepted decisions are awaiting an outcome mark with these filters.'
            : 'No accepted decisions yet — accept a session synthesis to populate.'}
        </p>
      ) : (
        <ul className="space-y-3">
          {decisions.map((d) => {
            const credited = d.credited_advisor_ids
              .map((id) => advisorById.get(id))
              .filter((a): a is NonNullable<typeof a> => Boolean(a));
            const overruled = d.overruled_advisor_ids
              .map((id) => advisorById.get(id))
              .filter((a): a is NonNullable<typeof a> => Boolean(a));
            return (
              <li key={d.id} className="rounded-md border border-[var(--border)] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span
                        className={`size-2 rounded-full ${OUTCOME_DOT[d.outcome] ?? 'bg-zinc-400'}`}
                      />
                      <span className="uppercase tracking-wide text-[var(--muted-foreground)]">
                        {OUTCOME_LABEL[d.outcome] ?? d.outcome}
                      </span>
                      {d.outcome_marked_at ? (
                        <span className="text-[var(--muted-foreground)]">
                          marked {fmtDate(d.outcome_marked_at)}
                        </span>
                      ) : null}
                    </div>
                    <h3 className="mt-1 text-sm font-medium">
                      <Link href={`/board/sessions/${d.session_id}`} className="hover:underline">
                        {d.session_title}
                      </Link>
                    </h3>
                    <div className="mt-2 text-sm">
                      <Markdown>{d.edited_decision_text ?? d.decision_text}</Markdown>
                    </div>
                    {credited.length > 0 || overruled.length > 0 ? (
                      <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                        {credited.length > 0 ? (
                          <span>
                            Credited: {credited.map((a) => `${a.emoji} ${a.name}`).join(', ')}
                          </span>
                        ) : null}
                        {credited.length > 0 && overruled.length > 0 ? <span> · </span> : null}
                        {overruled.length > 0 ? (
                          <span>
                            Overruled: {overruled.map((a) => `${a.emoji} ${a.name}`).join(', ')}
                          </span>
                        ) : null}
                      </p>
                    ) : null}
                  </div>
                  <div className="text-right text-xs text-[var(--muted-foreground)]">
                    <div>Accepted</div>
                    <div>{d.accepted_at ? fmtDate(d.accepted_at) : '—'}</div>
                  </div>
                </div>

                <div className="mt-3 border-t border-[var(--border)] pt-3">
                  <OutcomeMarker
                    decisionId={d.id}
                    initialOutcome={d.outcome}
                    initialNotes={d.outcome_notes}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function FilterLink({
  current,
  value,
  age,
  children,
}: {
  current: string;
  value: string;
  age: number;
  children: React.ReactNode;
}) {
  const active = current === value;
  const params = new URLSearchParams();
  params.set('filter', value);
  if (age > 0) params.set('age', String(age));
  return (
    <Link
      href={`/board/decisions?${params.toString()}`}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? 'border-[var(--foreground)] bg-[var(--muted)]'
          : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]'
      }`}
    >
      {children}
    </Link>
  );
}

function AgeLink({
  current,
  value,
  filter,
  children,
}: {
  current: number;
  value: number;
  filter: string;
  children: React.ReactNode;
}) {
  const active = current === value;
  const params = new URLSearchParams();
  params.set('filter', filter);
  if (value > 0) params.set('age', String(value));
  return (
    <Link
      href={`/board/decisions?${params.toString()}`}
      className={`rounded-full border px-3 py-1 transition ${
        active
          ? 'border-[var(--foreground)] bg-[var(--muted)]'
          : 'border-[var(--border)] text-[var(--muted-foreground)] hover:border-[var(--foreground)] hover:text-[var(--foreground)]'
      }`}
    >
      {children}
    </Link>
  );
}
