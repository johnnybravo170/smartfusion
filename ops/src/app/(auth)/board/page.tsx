import Link from 'next/link';
import { fmtDate } from '@/lib/tz';
import { listAdvisors, listSessions } from '@/server/ops-services/board';
import { NewSessionForm } from './new-session-form';

const STATUS_DOT: Record<string, string> = {
  pending: 'bg-zinc-400',
  running: 'bg-amber-500',
  awaiting_review: 'bg-sky-500',
  accepted: 'bg-emerald-500',
  edited: 'bg-emerald-500',
  rejected: 'bg-red-500',
  revised: 'bg-purple-500',
  failed: 'bg-red-500',
};

export const dynamic = 'force-dynamic';

export default async function BoardPage() {
  const [sessions, advisors] = await Promise.all([listSessions(50), listAdvisors()]);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Board of Advisors</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          A multi-agent strategic council. Convene a session, advisors debate, the chair (with your
          operating imprint) decides. Synthesis lands here for review.
        </p>
      </header>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Convene
        </h2>
        <NewSessionForm advisors={advisors} />
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Sessions
        </h2>
        {sessions.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
            No sessions yet. Convene one above.
          </p>
        ) : (
          <ul className="space-y-2">
            {sessions.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/board/sessions/${s.id}`}
                  className="block rounded-md border border-[var(--border)] p-4 transition hover:border-[var(--foreground)]"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={`size-2 rounded-full ${STATUS_DOT[s.status] ?? 'bg-zinc-400'}`}
                        />
                        <span className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
                          {s.status.replace('_', ' ')}
                        </span>
                      </div>
                      <h3 className="mt-1 text-sm font-medium">{s.title}</h3>
                      <p className="mt-1 line-clamp-2 text-sm text-[var(--muted-foreground)]">
                        {s.topic}
                      </p>
                    </div>
                    <div className="text-right text-xs text-[var(--muted-foreground)]">
                      <div>{fmtDate(s.created_at)}</div>
                      <div>
                        ${(s.spent_cents / 100).toFixed(2)} / ${(s.budget_cents / 100).toFixed(0)}
                      </div>
                      <div>{s.call_count} calls</div>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Advisors
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {advisors.map((a) => (
            <li key={a.id} className="rounded-md border border-[var(--border)] p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-base">{a.emoji}</span>
                <span className="font-medium">{a.name}</span>
                <span className="ml-auto rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                  {a.role_kind}
                </span>
              </div>
              <p className="mt-1 text-xs text-[var(--muted-foreground)]">{a.description}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
