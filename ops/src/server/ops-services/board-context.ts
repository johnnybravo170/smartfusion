/**
 * Live-context loader. Pulls a snapshot of HeyHenry-the-business state from
 * other ops.* tables and renders it into a Markdown block that gets pinned
 * into every advisor's user prompt at session start.
 *
 * One round-trip per source, all in parallel. Conservative limits — the
 * point is grounding, not reproducing the whole ops console.
 */

import { createServiceClient } from '@/lib/supabase';

export type BoardContextSnapshot = {
  /** Wall-clock when the snapshot was taken. ISO. */
  taken_at: string;
  decisions: Array<{ title: string; status: string; summary: string | null; created_at: string }>;
  ideas: Array<{ title: string; status: string; tags: string[]; created_at: string }>;
  roadmap: Array<{ title: string; status: string; phase: string | null }>;
  kanban: Array<{
    board: string;
    column: string;
    title: string;
    tags: string[];
    priority: number | null;
  }>;
  incidents: Array<{ title: string; severity: string; status: string; created_at: string }>;
  worklog: Array<{ summary: string; created_at: string }>;
  competitors: Array<{ name: string; last_checked_at: string | null }>;
  /** Knowledge docs the advisors should be aware of. Bodies truncated to
   *  ~1500 chars each so the context block stays bounded. Excludes docs
   *  tagged 'advisor' or 'imprint' (those are per-persona, loaded
   *  separately via advisor.knowledge_id). */
  knowledge: Array<{
    slug: string;
    title: string;
    tags: string[];
    body: string;
    truncated: boolean;
  }>;
};

const KNOWLEDGE_BODY_MAX = 1500;
const KNOWLEDGE_DOC_LIMIT = 20;
/** Tags that signal a doc is per-advisor / per-persona, NOT general
 *  context. We skip these because each advisor already gets its own
 *  skill body inlined separately. */
const KNOWLEDGE_EXCLUDE_TAGS = new Set(['advisor', 'imprint']);

export async function loadContextSnapshot(): Promise<BoardContextSnapshot> {
  const svc = createServiceClient();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const since_week = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    decisionsRes,
    ideasRes,
    roadmapRes,
    kanbanRes,
    incidentsRes,
    worklogRes,
    competitorsRes,
    knowledgeRes,
  ] = await Promise.all([
    svc
      .schema('ops')
      .from('decisions')
      .select('title, status, summary, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(15),
    svc
      .schema('ops')
      .from('ideas')
      .select('title, status, tags, created_at')
      .gte('created_at', since)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .limit(20),
    svc
      .schema('ops')
      .from('roadmap_items')
      .select('title, status, phase')
      .order('updated_at', { ascending: false })
      .limit(20),
    svc
      .schema('ops')
      .from('kanban_cards')
      .select('title, column_key, tags, priority, board_id, kanban_boards:board_id(slug)')
      .neq('column_key', 'done')
      .order('priority', { ascending: false, nullsFirst: false })
      .limit(20),
    svc
      .schema('ops')
      .from('incidents')
      .select('title, severity, status, created_at')
      .neq('status', 'resolved')
      .order('created_at', { ascending: false })
      .limit(10),
    svc
      .schema('ops')
      .from('worklog_entries')
      .select('summary, created_at')
      .gte('created_at', since_week)
      .order('created_at', { ascending: false })
      .limit(20),
    svc
      .schema('ops')
      .from('competitors')
      .select('name, last_checked_at')
      .order('last_checked_at', { ascending: false, nullsFirst: false })
      .limit(10),
    svc
      .schema('ops')
      .from('knowledge_docs')
      .select('slug, title, tags, body')
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(KNOWLEDGE_DOC_LIMIT * 3), // overfetch; we filter out advisor/imprint docs in code
  ]);

  // Best-effort: a single broken query shouldn't fail the whole snapshot.
  type KanbanRow = {
    title: string;
    column_key: string;
    tags: string[] | null;
    priority: number | null;
    kanban_boards: { slug: string } | { slug: string }[] | null;
  };
  return {
    taken_at: new Date().toISOString(),
    decisions: (decisionsRes.data ?? []).map((d) => ({
      title: d.title,
      status: d.status,
      summary: d.summary ?? null,
      created_at: d.created_at,
    })),
    ideas: (ideasRes.data ?? []).map((i) => ({
      title: i.title,
      status: i.status,
      tags: i.tags ?? [],
      created_at: i.created_at,
    })),
    roadmap: (roadmapRes.data ?? []).map((r) => ({
      title: r.title,
      status: r.status,
      phase: r.phase ?? null,
    })),
    kanban: ((kanbanRes.data ?? []) as KanbanRow[]).map((c) => {
      const boards = c.kanban_boards;
      const slug = Array.isArray(boards) ? (boards[0]?.slug ?? '') : (boards?.slug ?? '');
      return {
        board: slug,
        column: c.column_key,
        title: c.title,
        tags: c.tags ?? [],
        priority: c.priority,
      };
    }),
    incidents: (incidentsRes.data ?? []).map((i) => ({
      title: i.title,
      severity: i.severity,
      status: i.status,
      created_at: i.created_at,
    })),
    worklog: (worklogRes.data ?? []).map((w) => ({
      summary: w.summary,
      created_at: w.created_at,
    })),
    competitors: (competitorsRes.data ?? []).map((c) => ({
      name: c.name,
      last_checked_at: c.last_checked_at ?? null,
    })),
    knowledge: (
      (knowledgeRes.data ?? []) as Array<{
        slug: string;
        title: string;
        tags: string[] | null;
        body: string | null;
      }>
    )
      .filter((d) => !(d.tags ?? []).some((t) => KNOWLEDGE_EXCLUDE_TAGS.has(t)))
      .slice(0, KNOWLEDGE_DOC_LIMIT)
      .map((d) => {
        const body = d.body ?? '';
        const truncated = body.length > KNOWLEDGE_BODY_MAX;
        return {
          slug: d.slug,
          title: d.title,
          tags: d.tags ?? [],
          body: truncated ? `${body.slice(0, KNOWLEDGE_BODY_MAX)}…` : body,
          truncated,
        };
      }),
  };
}

/** Render the snapshot as a Markdown block to inject into prompts. */
export function renderContextBlock(s: BoardContextSnapshot): string {
  const lines: string[] = ['## Current state of HeyHenry', `(snapshot taken ${s.taken_at})`, ''];

  if (s.decisions.length) {
    lines.push('### Recent decisions (last 30d)');
    for (const d of s.decisions)
      lines.push(`- [${d.status}] ${d.title}${d.summary ? `. ${d.summary}` : ''}`);
    lines.push('');
  }
  if (s.roadmap.length) {
    lines.push('### Roadmap');
    for (const r of s.roadmap)
      lines.push(`- ${r.phase ? `(${r.phase}) ` : ''}${r.title} [${r.status}]`);
    lines.push('');
  }
  if (s.kanban.length) {
    lines.push('### Open kanban (not done)');
    for (const c of s.kanban) {
      const tag = c.tags.length ? ` [${c.tags.join(', ')}]` : '';
      lines.push(`- ${c.board}/${c.column}: ${c.title}${tag}`);
    }
    lines.push('');
  }
  if (s.incidents.length) {
    lines.push('### Open incidents');
    for (const i of s.incidents) lines.push(`- [${i.severity}] ${i.title} (${i.status})`);
    lines.push('');
  }
  if (s.worklog.length) {
    lines.push('### Recent worklog (last 7d)');
    for (const w of s.worklog.slice(0, 12)) lines.push(`- ${w.summary}`);
    lines.push('');
  }
  if (s.ideas.length) {
    lines.push('### Open ideas');
    for (const i of s.ideas.slice(0, 12))
      lines.push(`- [${i.status}] ${i.title}${i.tags.length ? ` {${i.tags.join(', ')}}` : ''}`);
    lines.push('');
  }
  if (s.competitors.length) {
    lines.push('### Tracked competitors');
    for (const c of s.competitors)
      lines.push(
        `- ${c.name}${c.last_checked_at ? ` (checked ${c.last_checked_at.slice(0, 10)})` : ''}`,
      );
    lines.push('');
  }
  if (s.knowledge.length) {
    lines.push('### Knowledge docs (HeyHenry-the-business reference material)');
    lines.push(
      `(Each is a short doc Jonathan or an agent has written down. Pull from them when relevant; ask for clarification if the right doc seems missing.)`,
    );
    lines.push('');
    for (const d of s.knowledge) {
      const tagStr = d.tags.length ? ` {${d.tags.join(', ')}}` : '';
      lines.push(`#### ${d.title}${tagStr} \`(${d.slug})\``);
      if (d.body) lines.push(d.body);
      if (d.truncated) lines.push(`*(truncated; full doc available via knowledge slug)*`);
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}
