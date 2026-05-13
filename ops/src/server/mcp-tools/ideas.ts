import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createServiceClient } from '@/lib/supabase';
import { getScoutReportCard } from '@/server/ops-services/ideas';
import { jsonResult, type McpToolCtx, withAudit } from './context';

export function registerIdeaTools(server: McpServer, ctx: McpToolCtx) {
  server.tool(
    'ideas_list',
    'List ideas (excludes archived), most recent first. Optional `status` filter.',
    {
      status: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(500).default(50),
    },
    withAudit(ctx, 'ideas_list', 'read:ideas', async ({ status, limit }) => {
      const service = createServiceClient();
      let q = service
        .schema('ops')
        .from('ideas')
        .select(
          'id, actor_type, actor_name, title, body, status, rating, assignee, tags, created_at, updated_at',
        )
        .is('archived_at', null)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonResult({ ideas: data ?? [] });
    }),
  );

  server.tool(
    'ideas_get',
    'Fetch a single idea with comments and followups.',
    { id: z.string().uuid() },
    withAudit(ctx, 'ideas_get', 'read:ideas', async ({ id }) => {
      const service = createServiceClient();
      const [idea, comments, followups] = await Promise.all([
        service
          .schema('ops')
          .from('ideas')
          .select(
            'id, actor_type, actor_name, title, body, status, rating, assignee, tags, created_at, updated_at, archived_at',
          )
          .eq('id', id)
          .maybeSingle(),
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
      if (!idea.data) throw new Error('Not found');
      return jsonResult({
        idea: idea.data,
        comments: comments.data ?? [],
        followups: followups.data ?? [],
      });
    }),
  );

  server.tool(
    'ideas_add',
    [
      'See ops_memory_guide for the full taxonomy.',
      '',
      'Capture a half-formed thought BEFORE it\u2019s a plan. Pre-commitment. Use when: surfacing an option to consider, a question Jonathan asked out loud, a pattern noticed but not yet acted on. Ideas graduate to kanban cards or decisions later. DO NOT use for actionable work (\u2192 kanban_card_create), established truth (\u2192 knowledge_write), or things that already happened (\u2192 worklog_add).',
      '',
      'File a new idea for Jonathan. Use for: feature suggestions, observations worth saving, things you noticed but did not act on. Returns a deep link.',
      '',
      'Optional `actor_name`: pass your routine slug (e.g. "business-scout") to override the default OAuth client_id stamp. Useful for per-agent attribution in the ops.agent_evidence view. Leave unset when calling from an ad-hoc terminal session.',
    ].join('\n'),
    {
      title: z.string().min(1).max(500),
      body: z.string().max(20000).optional().nullable(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      actor_name: z.string().min(1).max(100).optional(),
    },
    withAudit(ctx, 'ideas_add', 'write:ideas', async (input) => {
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from('ideas')
        .insert({
          actor_type: 'agent',
          actor_name: input.actor_name ?? ctx.actorName,
          key_id: ctx.keyId,
          title: input.title,
          body: input.body ?? null,
          tags: input.tags ?? [],
        })
        .select('id, created_at')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'Insert failed');
      return jsonResult({
        ok: true,
        id: data.id,
        url: `https://ops.heyhenry.io/ideas/${data.id}`,
      });
    }),
  );

  server.tool(
    'ideas_rate',
    'Rate an idea with -2/-1/+1/+2 and a reason. Explicit human feedback signal that all scout agents read on their next run. -2 = never propose this class again. -1 = low signal. +1 = good. +2 = more like this.',
    {
      id: z.string().uuid(),
      rating: z.union([z.literal(-2), z.literal(-1), z.literal(1), z.literal(2)]),
      reason: z.string().min(1).max(500),
    },
    withAudit(ctx, 'ideas_rate', 'write:ideas', async ({ id, rating, reason }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from('ideas')
        .update({
          user_rating: rating,
          user_rating_reason: reason,
          user_rated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .select('id')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) throw new Error('Idea not found');
      return jsonResult({ ok: true, id, rating, url: `https://ops.heyhenry.io/ideas/${id}` });
    }),
  );

  server.tool(
    'ideas_snooze',
    [
      'Defer an idea for re-evaluation at a future date.',
      '',
      'Sets `remind_at` and resets `review_status` to `pending`. The /api/ops/ideas-review/run cron picks the idea up at/after `remind_at`, asks Sonnet whether the idea is actionable in current business context, and either emails Jonathan or re-snoozes.',
      '',
      'Use this when an idea is interesting but blocked on timing, capital, or external dependencies. Example: "snooze the BC equipment-dealer co-marketing idea until 2026-08-01 — too pre-launch right now, revisit when the app is live."',
    ].join('\n'),
    {
      id: z.string().uuid(),
      remind_at: z
        .string()
        .datetime({ message: 'remind_at must be ISO 8601 UTC, e.g. 2026-08-01T15:00:00Z' }),
    },
    withAudit(ctx, 'ideas_snooze', 'write:ideas', async ({ id, remind_at }) => {
      const service = createServiceClient();
      const remindDate = new Date(remind_at);
      if (Number.isNaN(remindDate.getTime())) {
        return jsonResult({ ok: false, error: 'invalid remind_at' });
      }
      if (remindDate.getTime() <= Date.now()) {
        return jsonResult({
          ok: false,
          error: 'remind_at must be in the future — past dates would re-fire on the next cron run',
        });
      }
      const { data, error } = await service
        .schema('ops')
        .from('ideas')
        .update({
          remind_at: remindDate.toISOString(),
          review_status: 'pending',
          // Don't reset email_sent_at — even snoozed ideas should still have
          // appeared in their original daily digest. The review path is
          // additive, not a replacement for the digest.
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)
        .is('archived_at', null)
        .select('id, title, remind_at')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return jsonResult({ ok: false, error: 'not found or already archived' });
      return jsonResult({
        ok: true,
        id: data.id,
        title: data.title,
        remind_at: data.remind_at,
        url: `https://ops.heyhenry.io/ideas/${data.id}`,
      });
    }),
  );

  server.tool(
    'ideas_report_card',
    "Combined feedback view for a scout-style agent. Returns the agent's recently rated ideas (explicit -2/-1/+1/+2), promoted ideas (implicit +2), and archived-without-promotion ideas (implicit -1) in the window. Call this BEFORE producing new findings so you can adjust based on past signal.",
    {
      scout_tag: z.string().min(1).max(50),
      days: z.number().int().min(1).max(365).default(30),
    },
    withAudit(ctx, 'ideas_report_card', 'read:ideas', async ({ scout_tag, days }) => {
      const card = await getScoutReportCard(scout_tag, days);
      return jsonResult(card);
    }),
  );
}
