import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase';
import { CommentForm } from './comment-form';
import { IdeaActions } from './idea-actions';
import { PromoteToKanbanForm } from './promote-to-kanban-form';

export default async function IdeaDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const service = createServiceClient();

  const { data: idea } = await service
    .schema('ops')
    .from('ideas')
    .select(
      'id, title, body, actor_type, actor_name, status, rating, assignee, tags, created_at, updated_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (!idea) notFound();

  const [{ data: comments }, { data: followups }] = await Promise.all([
    service
      .schema('ops')
      .from('idea_comments')
      .select('id, actor_type, actor_name, body, created_at')
      .eq('idea_id', id)
      .order('created_at'),
    service
      .schema('ops')
      .from('idea_followups')
      .select('id, kind, payload, resolved_at, resolved_by_system, created_at')
      .eq('idea_id', id)
      .order('created_at', { ascending: false }),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Link href="/ideas" className="text-xs text-[var(--muted-foreground)] hover:underline">
        ← All ideas
      </Link>

      <header className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span className="uppercase tracking-wide">
            {(idea.status as string).replace('_', ' ')}
          </span>
          {idea.actor_type === 'agent' ? (
            <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              agent
            </span>
          ) : null}
          <span>· by {idea.actor_name}</span>
          <span>· {new Date(idea.created_at).toLocaleString()}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{idea.title}</h1>
        {idea.body ? (
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]">
            {idea.body}
          </p>
        ) : null}
        {Array.isArray(idea.tags) && idea.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {(idea.tags as string[]).map((t) => (
              <span key={t} className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px]">
                #{t}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      <IdeaActions
        id={id}
        status={idea.status as string}
        rating={(idea.rating as number | null) ?? null}
        assignee={(idea.assignee as string | null) ?? ''}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Promote to Kanban</h2>
        <PromoteToKanbanForm ideaId={id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Followups</h2>
        {followups && followups.length > 0 ? (
          <ul className="space-y-2">
            {followups.map((f) => (
              <li key={f.id} className="rounded-md border border-[var(--border)] px-3 py-2 text-xs">
                <div className="flex items-center justify-between gap-3">
                  <span>
                    <span className="font-mono font-medium">{f.kind}</span>
                    {f.resolved_at ? (
                      <span className="ml-2 text-emerald-600">resolved</span>
                    ) : (
                      <span className="ml-2 text-amber-600">pending</span>
                    )}
                  </span>
                  <span className="text-[var(--muted-foreground)]">
                    {new Date(f.created_at).toLocaleString()}
                  </span>
                </div>
                {f.payload && Object.keys(f.payload as object).length > 0 ? (
                  <pre className="mt-1 overflow-x-auto rounded bg-[var(--muted)] p-2 text-[11px]">
                    {JSON.stringify(f.payload, null, 2)}
                  </pre>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--muted-foreground)]">
            None yet. Queue one above and downstream systems will pick it up when they exist.
          </p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Comments {comments && comments.length > 0 ? `(${comments.length})` : ''}
        </h2>
        {comments && comments.length > 0 ? (
          <ul className="space-y-2">
            {comments.map((c) => (
              <li key={c.id} className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
                <div className="mb-1 flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                  <span className="font-medium text-[var(--foreground)]">{c.actor_name}</span>
                  {c.actor_type !== 'human' ? (
                    <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase">
                      {c.actor_type}
                    </span>
                  ) : null}
                  <span>· {new Date(c.created_at).toLocaleString()}</span>
                </div>
                <p className="whitespace-pre-wrap">{c.body}</p>
              </li>
            ))}
          </ul>
        ) : null}
        <CommentForm ideaId={id} />
      </section>
    </div>
  );
}
