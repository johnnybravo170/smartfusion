import { notFound } from 'next/navigation';
import { fmtDate } from '@/lib/tz';
import {
  getDecision,
  getSession,
  listAdvisorsWithKnowledge,
  listCruxes,
  listMessages,
  listPositions,
} from '@/server/ops-services/board';
import { DeleteSessionButton } from '../../delete-session-button';
import { Markdown } from '../../markdown';
import { AutoRefresh } from './auto-refresh';
import { MessageRating } from './message-rating';
import { ReviewPanel } from './review-panel';
import { RunButton } from './run-button';

export const dynamic = 'force-dynamic';

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

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) notFound();

  const [messages, cruxes, positions, decision, advisors] = await Promise.all([
    listMessages(id),
    listCruxes(id),
    listPositions(id),
    getDecision(id),
    listAdvisorsWithKnowledge(session.advisor_ids),
  ]);
  const byAdvisor = new Map(advisors.map((a) => [a.id, a]));

  const isLive = session.status === 'running' || session.status === 'pending';

  return (
    <div className="space-y-6">
      {isLive ? <AutoRefresh intervalMs={5000} /> : null}

      <header>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className={`size-2 rounded-full ${STATUS_DOT[session.status] ?? 'bg-zinc-400'}`}
            />
            <span className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
              {session.status.replace('_', ' ')}
            </span>
          </div>
          <DeleteSessionButton
            sessionId={session.id}
            status={session.status}
            redirectTo="/board"
            variant="button"
          />
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{session.title}</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-[var(--muted-foreground)]">
          {session.topic}
        </p>
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-[var(--muted-foreground)]">
          <span>Created {fmtDate(session.created_at)}</span>
          <span>
            ${(session.spent_cents / 100).toFixed(2)} of ${(session.budget_cents / 100).toFixed(2)}
          </span>
          <span>{session.call_count} calls</span>
          {session.provider_override ? (
            <span>
              {session.provider_override}/{session.model_override ?? '(default model)'}
            </span>
          ) : null}
        </div>
        {session.error_message ? (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20">
            {session.error_message}
          </p>
        ) : null}
      </header>

      {session.status === 'pending' ? <RunButton sessionId={session.id} /> : null}

      {decision ? (
        <section className="space-y-4">
          <h2 className="text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Decision ({decision.status})
          </h2>
          <div className="space-y-3 rounded-md border border-[var(--border)] p-4">
            <div className="text-base font-medium">
              <Markdown>{decision.edited_decision_text ?? decision.decision_text}</Markdown>
            </div>
            {decision.edited_decision_text ? (
              <p className="text-xs italic text-[var(--muted-foreground)]">
                Edited at accept-time. Original synthesis: "{decision.decision_text}"
              </p>
            ) : null}
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Reasoning
              </p>
              <Markdown>{decision.reasoning}</Markdown>
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Feedback-loop check
              </p>
              <Markdown>{decision.feedback_loop_check}</Markdown>
            </div>
            {(decision.edited_action_items ?? decision.action_items).length > 0 ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                  Action items
                </p>
                <ul className="mt-1 list-disc pl-5 text-sm">
                  {(decision.edited_action_items ?? decision.action_items).map((it) => (
                    // Action item text is unique within a decision; safe key.
                    <li key={it.text}>
                      {it.text}
                      {it.board_slug ? (
                        <span className="ml-2 text-xs text-[var(--muted-foreground)]">
                          → {it.board_slug}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {decision.chair_overrode_majority ? (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-amber-600">
                  Where the chair disagreed
                </p>
                <Markdown>{decision.chair_disagreement_note ?? '(no note)'}</Markdown>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3 text-xs text-[var(--muted-foreground)]">
              <span>
                Credited:{' '}
                {decision.credited_advisor_ids
                  .map((id) => byAdvisor.get(id)?.name ?? id)
                  .join(', ') || '(none)'}
              </span>
              <span>
                Overruled:{' '}
                {decision.overruled_advisor_ids
                  .map((id) => byAdvisor.get(id)?.name ?? id)
                  .join(', ') || '(none)'}
              </span>
            </div>
            {decision.status === 'rejected' && decision.rejected_reason ? (
              <p className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                Rejected: {decision.rejected_reason}
              </p>
            ) : null}
            {(decision.status === 'accepted' || decision.status === 'edited') &&
            decision.links &&
            typeof decision.links === 'object' &&
            'decision_id' in decision.links ? (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                Promoted: ops.decisions row{' '}
                {String((decision.links as { decision_id?: string }).decision_id)?.slice(0, 8)},{' '}
                {Array.isArray((decision.links as { kanban_card_ids?: unknown[] }).kanban_card_ids)
                  ? (decision.links as { kanban_card_ids: unknown[] }).kanban_card_ids.length
                  : 0}{' '}
                kanban card(s) on{' '}
                {Array.isArray((decision.links as { kanban_boards?: unknown[] }).kanban_boards)
                  ? (decision.links as { kanban_boards: string[] }).kanban_boards.join(', ') ||
                    'none'
                  : '?'}
                .
              </p>
            ) : null}
          </div>

          {session.status === 'awaiting_review' && decision.status === 'proposed' ? (
            <ReviewPanel session={session} decision={decision} />
          ) : null}
        </section>
      ) : null}

      {cruxes.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Cruxes ({cruxes.length})
          </h2>
          <ul className="space-y-1">
            {cruxes.map((c) => (
              <li key={c.id} className="rounded-md border border-[var(--border)] p-3 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                    {c.status}
                  </span>
                  <span className="font-medium">{c.label}</span>
                </div>
                {c.resolution_summary ? (
                  <p className="mt-1 text-xs text-[var(--muted-foreground)]">
                    {c.resolution_summary}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
          Transcript ({messages.length} messages)
        </h2>
        {messages.length === 0 ? (
          <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-sm text-[var(--muted-foreground)]">
            {session.status === 'pending' ? 'Run the session to populate.' : 'Empty.'}
          </p>
        ) : (
          <ol className="space-y-3">
            {messages.map((m) => {
              const advisor = m.advisor_id ? byAdvisor.get(m.advisor_id) : null;
              const ratable =
                m.advisor_id !== null &&
                m.turn_kind !== 'system' &&
                ['awaiting_review', 'accepted', 'edited', 'rejected', 'revised'].includes(
                  session.status,
                );
              return (
                <li key={m.id} className="rounded-md border border-[var(--border)] p-4">
                  <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted-foreground)]">
                    <div className="flex items-center gap-2">
                      <span>{advisor?.emoji ?? '·'}</span>
                      <span className="font-medium text-[var(--foreground)]">
                        {advisor?.name ?? '(system)'}
                      </span>
                      <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                        {m.turn_kind.replace('_', ' ')}
                      </span>
                    </div>
                    <span>{fmtDate(m.created_at)}</span>
                  </div>
                  <div className="mt-2">
                    <Markdown>{m.content}</Markdown>
                  </div>
                  {m.cost_cents !== null && m.cost_cents !== undefined ? (
                    <p className="mt-2 text-xs text-[var(--muted-foreground)]">
                      {m.provider}/{m.model} · {m.prompt_tokens}+{m.completion_tokens} tok · $
                      {((m.cost_cents ?? 0) / 100).toFixed(3)}
                    </p>
                  ) : null}
                  {ratable ? (
                    <MessageRating
                      messageId={m.id}
                      initialRating={m.advisor_rating}
                      initialNote={m.review_note}
                    />
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {positions.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
            Position grid
          </h2>
          <div className="overflow-x-auto rounded-md border border-[var(--border)] text-sm">
            <table className="min-w-full">
              <thead>
                <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted-foreground)]">
                  <th className="px-3 py-2">Advisor</th>
                  <th className="px-3 py-2">Overall stance</th>
                  <th className="px-3 py-2">Conf</th>
                </tr>
              </thead>
              <tbody>
                {advisors
                  .filter((a) => a.role_kind !== 'chair')
                  .map((a) => {
                    const overall = positions.find(
                      (p) => p.advisor_id === a.id && p.crux_id === null,
                    );
                    return (
                      <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                        <td className="px-3 py-2">
                          {a.emoji} {a.name}
                        </td>
                        <td className="px-3 py-2">{overall?.stance ?? '—'}</td>
                        <td className="px-3 py-2">{overall?.confidence ?? '—'}/5</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}
