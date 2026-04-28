import {
  type NoteFeedItem,
  ProjectNotesTab,
} from '@/components/features/projects/project-notes-tab';
import { listPhotosByProject } from '@/lib/db/queries/photos';
import { getBudgetVsActual } from '@/lib/db/queries/project-budget-categories';
import { getSignedUrls } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';

function buildNotesFeed(input: {
  notes: Array<Record<string, unknown>> | null;
  memos: Array<Record<string, unknown>> | null;
  events: Array<Record<string, unknown>> | null;
  artifactUrls: Map<string, string>;
}): NoteFeedItem[] {
  const items: NoteFeedItem[] = [];
  for (const n of input.notes ?? []) {
    const k = (n.kind as string) ?? 'text';
    if (k === 'reply_draft') {
      items.push({
        kind: 'reply_draft',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'henry_q') {
      items.push({
        kind: 'henry_q',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'henry_a') {
      items.push({
        kind: 'henry_a',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
      });
    } else if (k === 'artifact') {
      const meta = (n.metadata as Record<string, unknown> | null) ?? {};
      const imagePath = (meta.image_path as string | undefined) ?? null;
      items.push({
        kind: 'artifact',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
        artifact_kind: (meta.kind as string) ?? 'sketch',
        label: (meta.label as string) ?? 'Reference',
        image_url: imagePath ? (input.artifactUrls.get(imagePath) ?? null) : null,
      });
    } else {
      items.push({
        kind: 'note',
        id: n.id as string,
        created_at: n.created_at as string,
        body: n.body as string,
        author_name: null,
      });
    }
  }
  for (const m of input.memos ?? []) {
    items.push({
      kind: 'memo',
      id: m.id as string,
      created_at: m.created_at as string,
      transcript: (m.transcript as string | null) ?? null,
      status: (m.status as string) ?? 'ready',
    });
  }
  for (const e of input.events ?? []) {
    items.push({
      kind: 'event',
      id: e.id as string,
      created_at: e.created_at as string,
      title: (e.title as string | null) ?? null,
      body: (e.body as string | null) ?? null,
      entry_type: (e.entry_type as string) ?? 'system',
    });
  }
  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return items;
}

export default async function MemosTabServer({ projectId }: { projectId: string }) {
  const supabase = await createClient();
  const [{ data: memos }, projectPhotos, { data: notes }, { data: events }, budget] =
    await Promise.all([
      supabase
        .from('project_memos')
        .select('id, status, transcript, ai_extraction, created_at')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false }),
      listPhotosByProject(projectId),
      supabase
        .from('project_notes')
        .select('id, body, created_at, user_id, kind, metadata')
        .eq('project_id', projectId)
        .order('created_at', { ascending: false }),
      supabase
        .from('worklog_entries')
        .select('id, title, body, entry_type, created_at')
        .eq('related_type', 'project')
        .eq('related_id', projectId)
        .order('created_at', { ascending: false })
        .limit(100),
      getBudgetVsActual(projectId),
    ]);

  const artifactPaths = (notes ?? [])
    .filter((n) => (n.kind as string | undefined) === 'artifact')
    .map((n) => (n.metadata as { image_path?: string } | null)?.image_path)
    .filter((p): p is string => !!p);
  const artifactUrls = await getSignedUrls(artifactPaths);

  const memoPhotosByMemo = new Map<
    string,
    { id: string; url: string | null; caption: string | null }[]
  >();
  for (const p of projectPhotos) {
    if (!p.memo_id) continue;
    const list = memoPhotosByMemo.get(p.memo_id) ?? [];
    list.push({ id: p.id, url: p.url, caption: p.caption });
    memoPhotosByMemo.set(p.memo_id, list);
  }

  return (
    <ProjectNotesTab
      projectId={projectId}
      feed={buildNotesFeed({ notes, memos, events, artifactUrls })}
      memoUploadProps={{
        projectId,
        memos: (memos ?? []).map((m) => ({
          id: m.id as string,
          status: m.status as string,
          transcript: m.transcript as string | null,
          ai_extraction: m.ai_extraction as Record<string, unknown> | null,
          created_at: m.created_at as string,
          photos: memoPhotosByMemo.get(m.id as string) ?? [],
        })),
        buckets: budget.lines.map((b) => ({
          id: b.budget_category_id,
          name: b.budget_category_name,
          section: b.section,
        })),
      }}
    />
  );
}
