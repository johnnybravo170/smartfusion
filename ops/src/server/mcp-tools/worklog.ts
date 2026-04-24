import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase';
import { jsonResult, type McpToolCtx, withAudit } from './context';

export function registerWorklogTools(server: McpServer, ctx: McpToolCtx) {
  server.tool(
    'worklog_list',
    'List worklog entries (most recent first). Optional `since` ISO timestamp and freetext `q` (matches title/body).',
    {
      since: z.string().datetime().optional(),
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    withAudit(ctx, 'worklog_list', 'read:worklog', async ({ since, q, limit }) => {
      const service = createServiceClient();
      let query = service
        .schema('ops')
        .from('worklog_entries')
        .select('id, actor_type, actor_name, category, site, title, body, tags, created_at')
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (since) query = query.gte('created_at', since);
      if (q) query = query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return jsonResult({ entries: data ?? [] });
    }),
  );

  server.tool(
    'worklog_add',
    [
      'See ops_memory_guide for the full taxonomy.',
      '',
      'Record something that HAPPENED. Append-only feed. Use for: agent run summaries, what Jonathan did today, customer interactions, event-driven notes. DO NOT use for: actionable work (\u2192 kanban_card_create), evergreen truth (\u2192 knowledge_write), choices (\u2192 decisions_add), half-formed ideas (\u2192 ideas_add). Worklog entries should have dates that matter \u2014 the rule of thumb is "will this still be meaningful to read chronologically in 6 months?"',
      '',
      'Append a worklog entry. Use to record what you did this run \u2014 keeps a human-readable audit trail beyond the raw audit_log.',
    ].join('\n'),
    {
      title: z.string().min(1).max(500),
      body: z.string().max(20000).optional().nullable(),
      category: z.string().max(50).optional().nullable(),
      site: z.string().max(50).optional().nullable(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      related_type: z
        .enum([
          'kanban_card',
          'idea',
          'decision',
          'knowledge',
          'incident',
          'competitor',
          'doc',
          'commit',
          'url',
        ])
        .optional()
        .nullable()
        .describe(
          'Cross-link this entry to another ops object. One of: kanban_card | idea | decision | knowledge | incident | competitor | doc | commit | url.',
        ),
      related_id: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .nullable()
        .describe(
          "The target's id (uuid for db-backed types; freeform for commit sha / url / external refs).",
        ),
    },
    withAudit(ctx, 'worklog_add', 'write:worklog', async (input) => {
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from('worklog_entries')
        .insert({
          actor_type: 'agent',
          actor_name: ctx.actorName,
          key_id: ctx.keyId,
          title: input.title,
          body: input.body ?? null,
          category: input.category ?? null,
          site: input.site ?? null,
          tags: input.tags ?? [],
          related_type: input.related_type ?? null,
          related_id: input.related_id ?? null,
        })
        .select('id, created_at')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'Insert failed');
      return jsonResult({ ok: true, id: data.id });
    }),
  );
}
