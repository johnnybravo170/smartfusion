import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getCard } from '@/server/ops-services/kanban';
import { CardEditor } from './card-editor';
import { CommentForm } from './comment-form';

export default async function KanbanCardPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const res = await getCard(id);
  if (!res) notFound();
  const { card, events } = res;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/admin/kanban/${slug}`}
        className="text-xs text-[var(--muted-foreground)] hover:underline"
      >
        ← Board
      </Link>

      <CardEditor
        slug={slug}
        card={{
          id: card.id as string,
          title: card.title as string,
          body: (card.body as string | null) ?? '',
          column_key: card.column_key as string,
          tags: (card.tags as string[] | null) ?? [],
          due_date: (card.due_date as string | null) ?? '',
          priority: (card.priority as number | null) ?? null,
          assignee: (card.assignee as string | null) ?? '',
          suggested_agent: (card.suggested_agent as string | null) ?? '',
          related_type: (card.related_type as string | null) ?? '',
          related_id: (card.related_id as string | null) ?? '',
          recurring_rule: (card.recurring_rule as string | null) ?? '',
          blocked_by: (card.blocked_by as string[] | null) ?? [],
          archived_at: (card.archived_at as string | null) ?? null,
        }}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        <CommentForm id={id} slug={slug} />
        <ul className="space-y-1">
          {events.map((e) => (
            <li
              key={e.id as string}
              className="rounded-md border border-[var(--border)] px-3 py-2 text-xs"
            >
              <div className="flex items-center gap-2 text-[var(--muted-foreground)]">
                <span className="font-medium text-[var(--foreground)]">
                  {e.actor_name as string}
                </span>
                <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase">
                  {e.actor_type as string}
                </span>
                <span className="font-mono">{e.event_type as string}</span>
                <span className="ml-auto">{new Date(e.created_at as string).toLocaleString()}</span>
              </div>
              {e.body ? (
                <p className="mt-1 whitespace-pre-wrap text-[var(--foreground)]">
                  {e.body as string}
                </p>
              ) : null}
              {e.metadata && Object.keys(e.metadata as Record<string, unknown>).length > 0 ? (
                <pre className="mt-1 overflow-x-auto rounded bg-[var(--muted)] p-1 text-[10px]">
                  {JSON.stringify(e.metadata, null, 2)}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
