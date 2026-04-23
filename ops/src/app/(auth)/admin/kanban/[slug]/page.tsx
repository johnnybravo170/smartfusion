import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase';
import { KANBAN_COLUMNS, listCards } from '@/server/ops-services/kanban';
import { NewCardForm } from './new-card-form';

const COLUMN_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  todo: 'Todo',
  doing: 'Doing',
  blocked: 'Blocked',
  done: 'Done',
};

function priorityDot(p: number | null | undefined) {
  if (!p) return null;
  const colors = [
    '',
    'bg-sky-400',
    'bg-emerald-400',
    'bg-amber-400',
    'bg-orange-500',
    'bg-rose-500',
  ];
  return (
    <span
      className={`inline-block size-2 rounded-full ${colors[p] ?? 'bg-gray-400'}`}
      title={`Priority ${p}`}
    />
  );
}

function isOverdue(due: string | null | undefined, done: string | null | undefined) {
  if (!due || done) return false;
  return new Date(due).getTime() < Date.now();
}

export default async function KanbanBoardPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const service = createServiceClient();
  const { data: board } = await service
    .schema('ops')
    .from('kanban_boards')
    .select('id, name, slug, description')
    .eq('slug', slug)
    .maybeSingle();
  if (!board) notFound();

  const cards = await listCards({ boardSlug: slug, includeBlocked: true, limit: 500 });

  const byColumn: Record<string, typeof cards> = {};
  for (const c of KANBAN_COLUMNS) byColumn[c] = [];
  for (const c of cards) byColumn[c.column_key as string]?.push(c);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <Link href="/admin/kanban" className="hover:underline">
            ← Kanban
          </Link>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{board.name}</h1>
        {board.description ? (
          <p className="text-sm text-[var(--muted-foreground)]">{board.description}</p>
        ) : null}
      </header>

      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-5">
        {KANBAN_COLUMNS.map((col) => (
          <section key={col} className="space-y-2">
            <h2 className="sticky top-0 flex items-baseline justify-between text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
              <span>
                {COLUMN_LABEL[col]}{' '}
                <span className="text-[var(--muted-foreground)]/70">
                  ({(byColumn[col] ?? []).length})
                </span>
              </span>
            </h2>
            <NewCardForm boardSlug={slug} column={col} />
            <ul className="space-y-2">
              {(byColumn[col] ?? []).map((card) => {
                const overdue = isOverdue(
                  card.due_date as string | null,
                  card.done_at as string | null,
                );
                return (
                  <li key={card.id as string}>
                    <Link
                      href={`/admin/kanban/${slug}/${card.id}`}
                      className="block rounded-md border border-[var(--border)] p-3 text-sm transition hover:border-[var(--foreground)]"
                    >
                      <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                        {priorityDot(card.priority as number | null)}
                        {card.due_date ? (
                          <span className={overdue ? 'font-semibold text-rose-600' : ''}>
                            due {card.due_date as string}
                          </span>
                        ) : null}
                        {Array.isArray(card.blocked_by) &&
                        (card.blocked_by as string[]).length > 0 ? (
                          <span className="text-rose-500">blocked</span>
                        ) : null}
                      </div>
                      <div className="font-medium">{card.title as string}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {(card.tags as string[] | null)?.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px]"
                          >
                            #{t}
                          </span>
                        ))}
                      </div>
                      {card.assignee || card.suggested_agent ? (
                        <div className="mt-1 text-xs text-[var(--muted-foreground)]">
                          {card.assignee ? `@${card.assignee as string}` : null}
                          {card.assignee && card.suggested_agent ? ' · ' : null}
                          {card.suggested_agent ? (
                            <span className="italic">→ {card.suggested_agent as string}</span>
                          ) : null}
                        </div>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
              {(byColumn[col] ?? []).length === 0 ? (
                <li className="rounded-md border border-dashed border-[var(--border)] px-3 py-4 text-center text-xs text-[var(--muted-foreground)]">
                  Empty
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
