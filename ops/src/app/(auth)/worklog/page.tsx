import { createServiceClient } from '@/lib/supabase';
import { ArchiveButton } from './archive-button';
import { WorklogForm } from './worklog-form';

export default async function WorklogPage() {
  const service = createServiceClient();
  const { data: entries } = await service
    .schema('ops')
    .from('worklog_entries')
    .select('id, actor_type, actor_name, category, site, title, body, tags, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(200);

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Worklog</h1>
        <p className="mt-1 text-sm text-[var(--muted-foreground)]">
          Timeline of what's been happening. Agents append via API; humans via this page.
        </p>
      </header>

      <WorklogForm />

      {entries && entries.length > 0 ? (
        <ul className="space-y-3">
          {entries.map((e) => (
            <li key={e.id} className="rounded-md border border-[var(--border)] p-4 text-sm">
              <div className="mb-2 flex items-center justify-between gap-4 text-xs text-[var(--muted-foreground)]">
                <span>
                  <span className="font-medium text-[var(--foreground)]">{e.actor_name}</span>
                  {e.actor_type === 'agent' ? (
                    <span className="ml-2 rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                      agent
                    </span>
                  ) : null}
                  {e.category ? <span className="ml-2">· {e.category}</span> : null}
                  {e.site ? <span className="ml-2">· {e.site}</span> : null}
                </span>
                <div className="flex items-center gap-2">
                  <span>{new Date(e.created_at).toLocaleString()}</span>
                  <ArchiveButton id={e.id} />
                </div>
              </div>
              <div className="font-medium">{e.title ?? '(no title)'}</div>
              {e.body ? (
                <p className="mt-1 whitespace-pre-wrap text-[var(--muted-foreground)]">{e.body}</p>
              ) : null}
              {Array.isArray(e.tags) && e.tags.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {e.tags.map((t: string) => (
                    <span key={t} className="rounded bg-[var(--muted)] px-1.5 py-0.5 text-[10px]">
                      #{t}
                    </span>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-dashed border-[var(--border)] px-4 py-8 text-center text-sm text-[var(--muted-foreground)]">
          No entries yet.
        </p>
      )}
    </div>
  );
}
