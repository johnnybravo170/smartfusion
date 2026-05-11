/**
 * Meta-tools that sit across the five memory surfaces:
 *   - ops_memory_guide:     taxonomy + when-to-use rules (no scope required)
 *   - ops_graph_lookup:     universal resolver by (type,id) across surfaces
 *   - ops_activity_digest:  aggregator across worklog/kanban/incidents/etc.
 *
 * Cross-surface tools deliberately degrade gracefully: if the caller\u2019s token
 * has no access to a given surface, it\u2019s returned as `"(no access)"` rather
 * than erroring.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Scope } from '@/lib/keys';
import { createServiceClient } from '@/lib/supabase';
import { renderMarkdown, type SurfaceKey } from '@/server/ops-services/memory-guide';
import { hasScope, jsonResult, type McpToolCtx, withAudit } from './context';

const ADMIN_BASE = 'https://ops.heyhenry.io';

const SURFACE_ENUM = z.enum(['kanban', 'worklog', 'ideas', 'knowledge', 'decisions']);

const LOOKUP_TYPE_ENUM = z.enum([
  'kanban_card',
  'worklog',
  'idea',
  'decision',
  'knowledge',
  'incident',
  'competitor',
  'social_draft',
  'doc',
]);

type LookupType = z.infer<typeof LOOKUP_TYPE_ENUM>;

/**
 * Map of lookup type → (required read scope, table, select, admin url builder).
 * Keeps the graph-lookup switch logic tiny.
 */
const LOOKUP_CONFIG: Record<
  LookupType,
  {
    scope: Scope;
    table: string;
    columns: string;
    titleField: string;
    bodyField: string | null;
    statusField: string | null;
    urlFor: (row: Record<string, unknown>) => string;
  }
> = {
  kanban_card: {
    scope: 'read:kanban',
    table: 'kanban_cards',
    columns: 'id, title, body, column_key, created_at, board_id',
    titleField: 'title',
    bodyField: 'body',
    statusField: 'column_key',
    urlFor: () => `${ADMIN_BASE}/admin/kanban`,
  },
  worklog: {
    scope: 'read:worklog',
    table: 'worklog_entries',
    columns: 'id, title, body, category, created_at',
    titleField: 'title',
    bodyField: 'body',
    statusField: 'category',
    urlFor: (r) => `${ADMIN_BASE}/worklog/${String(r.id ?? '')}`,
  },
  idea: {
    scope: 'read:ideas',
    table: 'ideas',
    columns: 'id, title, body, status, created_at',
    titleField: 'title',
    bodyField: 'body',
    statusField: 'status',
    urlFor: (r) => `${ADMIN_BASE}/ideas/${String(r.id ?? '')}`,
  },
  decision: {
    scope: 'read:decisions',
    table: 'decisions',
    columns: 'id, title, hypothesis, action, status, created_at',
    titleField: 'title',
    bodyField: 'hypothesis',
    statusField: 'status',
    urlFor: (r) => `${ADMIN_BASE}/decisions/${String(r.id ?? '')}`,
  },
  knowledge: {
    scope: 'read:knowledge',
    table: 'knowledge_docs',
    columns: 'id, title, body, created_at',
    titleField: 'title',
    bodyField: 'body',
    statusField: null,
    urlFor: (r) => `${ADMIN_BASE}/knowledge/${String(r.id ?? '')}`,
  },
  incident: {
    scope: 'read:incidents',
    table: 'incidents',
    columns: 'id, title, body, status, severity, source, created_at',
    titleField: 'title',
    bodyField: 'body',
    statusField: 'status',
    urlFor: (r) => `${ADMIN_BASE}/admin/incidents/${String(r.id ?? '')}`,
  },
  competitor: {
    scope: 'read:competitors',
    table: 'competitors',
    columns: 'id, name, url, edge_notes, latest_findings, last_checked_at, created_at',
    titleField: 'name',
    bodyField: 'edge_notes',
    statusField: null,
    urlFor: (r) => `${ADMIN_BASE}/admin/competitors/${String(r.id ?? '')}`,
  },
  social_draft: {
    scope: 'read:social',
    table: 'social_drafts',
    columns: 'id, title, body, channel, status, created_at',
    titleField: 'title',
    bodyField: 'body',
    statusField: 'status',
    urlFor: (r) => `${ADMIN_BASE}/admin/social/${String(r.id ?? '')}`,
  },
  doc: {
    scope: 'read:docs',
    table: 'docs',
    columns: 'id, module, commit_range, summary_md, created_at',
    titleField: 'module',
    bodyField: 'summary_md',
    statusField: null,
    urlFor: (r) => `${ADMIN_BASE}/admin/docs/${String(r.id ?? '')}`,
  },
};

/**
 * Best-effort list helper. Returns `"(no access)"` when the scope is absent
 * and `[]` when the table is reachable but empty / erroring — we never throw
 * from an aggregator just because one surface is locked down.
 */
async function safeList<T extends Record<string, unknown>>(
  ctx: McpToolCtx,
  scope: Scope,
  runner: () => Promise<T[]>,
): Promise<T[] | '(no access)'> {
  if (!hasScope(ctx, scope)) return '(no access)';
  try {
    return await runner();
  } catch {
    return [];
  }
}

export function registerMetaTools(server: McpServer, ctx: McpToolCtx) {
  // ---- ops_memory_guide --------------------------------------------------
  server.tool(
    'ops_memory_guide',
    [
      'Read the full HeyHenry ops memory taxonomy: the five surfaces (Kanban, Worklog, Ideas, Knowledge, Decisions), the 3-second heuristic for picking the right one, and cross-linking patterns.',
      '',
      'Call this BEFORE writing anything if you are unsure which surface to use. No scope required.',
      '',
      'Pass `surface` to get details on just one surface (kanban|worklog|ideas|knowledge|decisions).',
    ].join('\n'),
    {
      surface: SURFACE_ENUM.optional(),
    },
    // No scope check — this is a read-only doc. Still run through withAudit
    // with a lightweight scope that every key should have. We pick `read:kanban`
    // as the baseline since every surface agent has at least that; but the
    // handler below short-circuits before the scope check by using the
    // weakest scope in the system. Actually: we deliberately skip withAudit
    // here so that unscoped tokens can still call it.
    async ({ surface }: { surface?: SurfaceKey }) => {
      const md = renderMarkdown(surface);
      return jsonResult({ markdown: md });
    },
  );

  // ---- ops_graph_lookup --------------------------------------------------
  server.tool(
    'ops_graph_lookup',
    [
      'Universal resolver across ops surfaces. Give it `(type, id)` and get back `{ title, body, status, created_at, url }`.',
      '',
      'Types: kanban_card, worklog, idea, decision, knowledge, incident, competitor, social_draft, doc.',
      '',
      'Use this to follow cross-links without knowing which specific per-surface tool to call. Requires the read scope for that type \u2014 returns an error if missing.',
    ].join('\n'),
    {
      type: LOOKUP_TYPE_ENUM,
      id: z.string().min(1).max(200),
    },
    withAudit(ctx, 'ops_graph_lookup', 'read:kanban', async ({ type, id }) => {
      const cfg = LOOKUP_CONFIG[type];
      // Per-type scope check on top of the baseline audit scope.
      if (!hasScope(ctx, cfg.scope)) {
        return jsonResult({ ok: false, error: `missing scope ${cfg.scope}` });
      }
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from(cfg.table)
        .select(cfg.columns)
        .eq('id', id)
        .maybeSingle();
      if (error) return jsonResult({ ok: false, error: error.message });
      if (!data) return jsonResult({ ok: false, error: 'not found' });
      const row = data as unknown as Record<string, unknown>;
      return jsonResult({
        ok: true,
        type,
        id,
        title: row[cfg.titleField] ?? null,
        body: cfg.bodyField ? (row[cfg.bodyField] ?? null) : null,
        status: cfg.statusField ? (row[cfg.statusField] ?? null) : null,
        created_at: row.created_at ?? null,
        url: cfg.urlFor(row),
      });
    }),
  );

  // ---- ops_activity_digest ----------------------------------------------
  server.tool(
    'ops_activity_digest',
    [
      'Aggregate across all ops surfaces for a rolling window (default 7 days). Returns recent worklog, kanban motion (done/new/doing/blocked), incidents opened+resolved, competitors refreshed, docs added, and git totals.',
      '',
      'Each list is capped at 30 items. Surfaces the caller cannot read appear as `"(no access)"` instead of erroring.',
      '',
      'Use this to orient at the start of a run, or as the input to a weekly-digest agent.',
    ].join('\n'),
    {
      days: z.number().int().min(1).max(90).optional().default(7),
    },
    withAudit(ctx, 'ops_activity_digest', 'read:kanban', async ({ days }) => {
      const service = createServiceClient();
      const end = new Date();
      const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      const CAP = 30;

      // --- "you are here" phase context ---
      // Always fetch knowledge docs tagged 'now' so agents orient on the
      // current business stage before reading the activity data.
      const now_context = await safeList(ctx, 'read:knowledge', async () => {
        const { data } = await service
          .schema('ops')
          .from('knowledge_docs')
          .select('slug, title, body, updated_at')
          .is('archived_at', null)
          .contains('tags', ['now'])
          .order('updated_at', { ascending: false })
          .limit(3);
        return (data ?? []).map((d) => ({
          slug: d.slug as string,
          title: d.title as string,
          body: d.body as string | null,
          updated_at: d.updated_at as string,
        }));
      });

      // --- worklog ---
      const worklog = await safeList(ctx, 'read:worklog', async () => {
        const { data } = await service
          .schema('ops')
          .from('worklog_entries')
          .select('id, title, category, actor_name, created_at')
          .is('archived_at', null)
          .gte('created_at', startIso)
          .order('created_at', { ascending: false })
          .limit(CAP);
        return data ?? [];
      });

      // --- kanban motion ---
      let kanban:
        | '(no access)'
        | {
            done: unknown[];
            new: unknown[];
            moved_to_doing: unknown[];
            moved_to_blocked: unknown[];
          } = '(no access)';
      if (hasScope(ctx, 'read:kanban')) {
        try {
          const [doneRes, newRes, doingRes, blockedRes] = await Promise.all([
            service
              .schema('ops')
              .from('kanban_cards')
              .select('id, title, done_at, assignee')
              .gte('done_at', startIso)
              .lte('done_at', endIso)
              .order('done_at', { ascending: false })
              .limit(CAP),
            service
              .schema('ops')
              .from('kanban_cards')
              .select('id, title, created_at, assignee')
              .gte('created_at', startIso)
              .order('created_at', { ascending: false })
              .limit(CAP),
            service
              .schema('ops')
              .from('kanban_cards')
              .select('id, title, updated_at, assignee')
              .eq('column_key', 'doing')
              .is('archived_at', null)
              .gte('updated_at', startIso)
              .order('updated_at', { ascending: false })
              .limit(CAP),
            service
              .schema('ops')
              .from('kanban_cards')
              .select('id, title, updated_at, assignee')
              .eq('column_key', 'blocked')
              .is('archived_at', null)
              .gte('updated_at', startIso)
              .order('updated_at', { ascending: false })
              .limit(CAP),
          ]);
          kanban = {
            done: doneRes.data ?? [],
            new: newRes.data ?? [],
            moved_to_doing: doingRes.data ?? [],
            moved_to_blocked: blockedRes.data ?? [],
          };
        } catch {
          kanban = { done: [], new: [], moved_to_doing: [], moved_to_blocked: [] };
        }
      }

      // --- incidents ---
      let incidents: '(no access)' | { opened: unknown[]; resolved: unknown[] } = '(no access)';
      if (hasScope(ctx, 'read:incidents')) {
        try {
          const [openedRes, resolvedRes] = await Promise.all([
            service
              .schema('ops')
              .from('incidents')
              .select('id, title, severity, source, created_at')
              .gte('created_at', startIso)
              .order('created_at', { ascending: false })
              .limit(CAP),
            service
              .schema('ops')
              .from('incidents')
              .select('id, title, severity, resolved_at')
              .gte('resolved_at', startIso)
              .order('resolved_at', { ascending: false })
              .limit(CAP),
          ]);
          incidents = {
            opened: openedRes.data ?? [],
            resolved: resolvedRes.data ?? [],
          };
        } catch {
          incidents = { opened: [], resolved: [] };
        }
      }

      // --- competitors refreshed ---
      const competitors_refreshed = await safeList(ctx, 'read:competitors', async () => {
        const { data } = await service
          .schema('ops')
          .from('competitors')
          .select('id, name, last_checked_at')
          .gte('last_checked_at', startIso)
          .order('last_checked_at', { ascending: false })
          .limit(CAP);
        return data ?? [];
      });

      // --- docs added ---
      const docs_added = await safeList(ctx, 'read:docs', async () => {
        const { data } = await service
          .schema('ops')
          .from('docs')
          .select('id, module, commit_range, created_at')
          .gte('created_at', startIso)
          .order('created_at', { ascending: false })
          .limit(CAP);
        return data ?? [];
      });

      // --- git ---
      let commits = 0;
      let loc_added = 0;
      let loc_deleted = 0;
      let active_days = 0;
      try {
        const startDay = startIso.slice(0, 10);
        const { data: gitRows } = await service
          .schema('ops')
          .from('git_daily_stats')
          .select('day, commit_count, loc_added, loc_deleted')
          .gte('day', startDay);
        for (const r of gitRows ?? []) {
          const cc = (r.commit_count as number) ?? 0;
          commits += cc;
          loc_added += (r.loc_added as number) ?? 0;
          loc_deleted += (r.loc_deleted as number) ?? 0;
          if (cc > 0) active_days += 1;
        }
      } catch {
        // swallow — git stats are optional
      }

      const parts: string[] = [];
      if (kanban !== '(no access)') {
        parts.push(`${kanban.done.length} shipped`);
        parts.push(`${kanban.new.length} new cards`);
      }
      if (incidents !== '(no access)') parts.push(`${incidents.opened.length} incidents opened`);
      parts.push(`${commits} commits`);
      const headline = `Last ${days}d: ${parts.join(' \u00b7 ')}`;

      return jsonResult({
        now_context,
        window: { start: startIso, end: endIso, days },
        worklog,
        kanban,
        incidents,
        competitors_refreshed,
        docs_added,
        git: {
          commits,
          loc_net: loc_added - loc_deleted,
          active_days,
        },
        headline,
      });
    }),
  );
}
