import Link from 'next/link';
import { listBoards } from '@/server/ops-services/kanban';

const COLUMNS = ['backlog', 'todo', 'doing', 'blocked', 'done'] as const;

export default async function KanbanLandingPage() {
  const boards = await listBoards();

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Kanban</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Work boards for humans and agents. Agents pick up cards via MCP; this is the read-out.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {boards.map((b) => {
          const total = Object.values(b.counts).reduce((a, n) => a + n, 0);
          return (
            <Link
              key={b.id}
              href={`/admin/kanban/${b.slug}`}
              className="rounded-md border border-[var(--border)] p-4 transition hover:border-[var(--foreground)]"
            >
              <div className="flex items-baseline justify-between">
                <div className="text-lg font-semibold">{b.name}</div>
                <div className="text-xs text-[var(--muted-foreground)]">{total} cards</div>
              </div>
              {b.description ? (
                <p className="mt-1 text-xs text-[var(--muted-foreground)]">{b.description}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                {COLUMNS.map((c) => (
                  <span key={c} className="rounded bg-[var(--muted)] px-1.5 py-0.5">
                    {c} {b.counts[c] ?? 0}
                  </span>
                ))}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
