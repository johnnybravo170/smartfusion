import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createServiceClient } from '@/lib/supabase';

/**
 * Mirrors the `urlFor` logic in `ops_graph_lookup` (mcp-tools/meta.ts).
 * Kept local (not imported) because meta.ts URLs are absolute and server-only;
 * here we want in-app relative links.
 */
function relatedUrl(type: string, id: string): string | null {
  switch (type) {
    case 'kanban_card':
      return '/admin/kanban';
    case 'idea':
      return `/ideas/${id}`;
    case 'decision':
      return `/decisions/${id}`;
    case 'knowledge':
      return `/knowledge/${id}`;
    case 'incident':
      return `/admin/incidents/${id}`;
    case 'competitor':
      return `/admin/competitors/${id}`;
    case 'doc':
      return `/admin/docs/${id}`;
    case 'url':
      return id;
    case 'commit':
      return null;
    default:
      return null;
  }
}

export default async function WorklogDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const service = createServiceClient();

  const { data: entry } = await service
    .schema('ops')
    .from('worklog_entries')
    .select(
      'id, actor_type, actor_name, category, site, title, body, tags, created_at, related_type, related_id',
    )
    .eq('id', id)
    .maybeSingle();
  if (!entry) notFound();

  const relatedType = (entry.related_type as string | null) ?? null;
  const relatedId = (entry.related_id as string | null) ?? null;
  const relatedHref = relatedType && relatedId ? relatedUrl(relatedType, relatedId) : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/worklog" className="text-xs text-[var(--muted-foreground)] hover:underline">
        ← Back to worklog
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--muted-foreground)]">
          <span className="font-medium text-[var(--foreground)]">{entry.actor_name}</span>
          {entry.actor_type === 'agent' ? (
            <span className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              agent
            </span>
          ) : null}
          {entry.category ? <span>· {entry.category as string}</span> : null}
          {entry.site ? <span>· {entry.site as string}</span> : null}
          <span>· {new Date(entry.created_at as string).toLocaleString()}</span>
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {(entry.title as string) ?? '(no title)'}
        </h1>
        {Array.isArray(entry.tags) && entry.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 pt-1">
            {(entry.tags as string[]).map((t) => (
              <span key={t} className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px]">
                #{t}
              </span>
            ))}
          </div>
        ) : null}
      </header>

      {entry.body ? (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--foreground)]">
          {entry.body as string}
        </p>
      ) : null}

      {relatedType && relatedId ? (
        <section className="rounded-md border border-[var(--border)] p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-[var(--muted-foreground)]">
            Related
          </div>
          <div className="mt-1">
            <span className="font-mono text-xs">{relatedType}</span>
            <span className="mx-2 text-[var(--muted-foreground)]">·</span>
            {relatedHref ? (
              <Link href={relatedHref} className="underline hover:no-underline">
                {relatedId}
              </Link>
            ) : (
              <span className="font-mono text-xs">{relatedId}</span>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
