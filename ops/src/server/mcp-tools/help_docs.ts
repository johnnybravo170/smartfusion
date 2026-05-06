/**
 * MCP tools for the operator-audience help_docs corpus.
 *
 * Parallel of `knowledge.ts` (which writes engineer-audience docs into
 * `ops.knowledge_docs`). Help docs live in `public.help_docs` and back
 * Henry's RAG once the catalog is solid (see kanban f8940f06).
 *
 * Phase 1 (this PR): tools so docs can be hand-curated or written by an
 * existing Claude Code session via MCP. Drafts land with is_published=false;
 * a human flips publish via `help_docs_publish`.
 *
 * Phase 2 (next PR): a doc-writer Routine consumes these tools to draft
 * help docs from merged PRs. Same surface, more callers.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { contentHash, embedText } from '@/lib/embed';
import { createServiceClient } from '@/lib/supabase';
import { jsonResult, type McpToolCtx, withAudit } from './context';

const AUDIENCE = z.enum(['operator', 'public']);

export function registerHelpDocsTools(server: McpServer, ctx: McpToolCtx) {
  // ──────────────────────────────────────────────────────────────────
  // help_docs_search — semantic search
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_search',
    [
      'Semantic search over the operator-audience help_docs corpus. Use to answer "where is X?" / "how do I X?" before claiming HeyHenry doesn\'t support something.',
      '',
      'Returns hits ranked by cosine similarity. Defaults to operator audience + published-only. Pass include_unpublished=true to surface drafts (review surface only).',
    ].join('\n'),
    {
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(50).default(10),
      min_similarity: z.number().min(0).max(1).default(0.4),
      audience: AUDIENCE.default('operator'),
      include_unpublished: z.boolean().default(false),
    },
    withAudit(
      ctx,
      'help_docs_search',
      'read:help_docs',
      async ({ query, limit, min_similarity, audience, include_unpublished }) => {
        const service = createServiceClient();
        const vector = await embedText(query);
        const { data, error } = await service.rpc('help_docs_search', {
          query_embedding: vector,
          match_limit: limit,
          min_similarity,
          audience_filter: audience,
          include_unpublished,
        });
        if (error) throw new Error(error.message);
        return jsonResult({ hits: data ?? [] });
      },
    ),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_write — create a draft (is_published=false)
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_write',
    [
      'Create a new help_doc DRAFT. Always lands with is_published=false — a human flips publish via `help_docs_publish` after review.',
      '',
      'Body is operator-voiced markdown ("To send a referral by SMS, go to Refer & Earn, type the phone number, hit Send."). DO NOT write engineer-audience content here — that goes to `knowledge_write`.',
      '',
      'Provide `route` (the canonical app path the doc explains, e.g. /referrals) when the doc is page-specific; leave null for cross-cutting topics.',
      '',
      'Provide `source_pr` + `source_commit` when the doc was generated from a specific PR so we can audit-trail back.',
    ].join('\n'),
    {
      title: z.string().min(1).max(500),
      summary: z.string().max(500).optional(),
      body: z.string().min(1).max(50000),
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case ascii only')
        .optional(),
      route: z.string().max(500).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      audience: AUDIENCE.default('operator'),
      source_pr: z.number().int().positive().optional(),
      source_commit: z.string().min(7).max(64).optional(),
    },
    withAudit(ctx, 'help_docs_write', 'write:help_docs', async (input) => {
      const service = createServiceClient();
      const { data, error } = await service
        .from('help_docs')
        .insert({
          actor_type: 'agent',
          actor_name: ctx.actorName,
          title: input.title,
          summary: input.summary ?? null,
          body: input.body,
          slug: input.slug ?? null,
          route: input.route ?? null,
          tags: input.tags ?? [],
          audience: input.audience,
          source_pr: input.source_pr ?? null,
          source_commit: input.source_commit ?? null,
          is_published: false,
        })
        .select('id, title')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'Insert failed');

      try {
        const text = `${data.title}\n\n${input.body}`;
        const [vector, hash] = await Promise.all([embedText(text), contentHash(text)]);
        await service.from('help_doc_embeddings').insert({
          doc_id: data.id,
          embedding: vector,
          content_hash: hash,
        });
        await service
          .from('help_docs')
          .update({ embedding_updated_at: new Date().toISOString() })
          .eq('id', data.id);
      } catch (e) {
        return jsonResult({
          ok: true,
          id: data.id,
          is_published: false,
          warning: `Saved but embedding failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return jsonResult({ ok: true, id: data.id, is_published: false });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_update — patch
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_update',
    [
      'Patch an existing help_doc by UUID. Only provided fields change.',
      'Re-embeds when `body` changes.',
      'Does NOT change publish state — use `help_docs_publish`/`help_docs_unpublish` for that.',
    ].join('\n'),
    {
      id: z.string().uuid(),
      title: z.string().min(1).max(500).optional(),
      summary: z.string().max(500).optional(),
      body: z.string().min(1).max(50000).optional(),
      slug: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[a-z0-9][a-z0-9-]*$/, 'kebab-case ascii only')
        .optional(),
      route: z.string().max(500).nullable().optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      audience: AUDIENCE.optional(),
    },
    withAudit(ctx, 'help_docs_update', 'write:help_docs', async ({ id, ...input }) => {
      const service = createServiceClient();

      const { data: existing, error: fetchErr } = await service
        .from('help_docs')
        .select('id, title, body, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (fetchErr) throw new Error(fetchErr.message);
      if (!existing) return jsonResult({ ok: false, error: 'not found' });
      if (existing.archived_at) return jsonResult({ ok: false, error: 'doc is archived' });

      const patch: Record<string, unknown> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.summary !== undefined) patch.summary = input.summary;
      if (input.body !== undefined) patch.body = input.body;
      if (input.slug !== undefined) patch.slug = input.slug;
      if (input.route !== undefined) patch.route = input.route;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (input.audience !== undefined) patch.audience = input.audience;
      if (Object.keys(patch).length === 0) {
        return jsonResult({ ok: true, id, changed: false });
      }

      const { error: updErr } = await service.from('help_docs').update(patch).eq('id', id);
      if (updErr) throw new Error(updErr.message);

      const bodyChanged = input.body !== undefined && input.body !== existing.body;
      if (bodyChanged) {
        try {
          const newTitle = input.title ?? (existing.title as string);
          const text = `${newTitle}\n\n${input.body as string}`;
          const [vector, hash] = await Promise.all([embedText(text), contentHash(text)]);
          await service.from('help_doc_embeddings').upsert(
            {
              doc_id: id,
              embedding: vector,
              content_hash: hash,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'doc_id' },
          );
          await service
            .from('help_docs')
            .update({ embedding_updated_at: new Date().toISOString() })
            .eq('id', id);
        } catch (e) {
          return jsonResult({
            ok: true,
            id,
            changed: true,
            warning: `Updated but re-embed failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }

      return jsonResult({ ok: true, id, changed: true, re_embedded: bodyChanged });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_list — review surface
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_list',
    'List recent help_docs. Pass status="draft" for unpublished review queue, "published" for live, or "all". Filter by audience and tag.',
    {
      status: z.enum(['draft', 'published', 'all']).default('all'),
      audience: AUDIENCE.optional(),
      tag: z.string().max(50).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    },
    withAudit(ctx, 'help_docs_list', 'read:help_docs', async ({ status, audience, tag, limit }) => {
      const service = createServiceClient();
      let q = service
        .from('help_docs')
        .select(
          'id, slug, title, summary, route, tags, audience, is_published, source_pr, actor_name, created_at, updated_at',
        )
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        .limit(limit);
      if (status === 'draft') q = q.eq('is_published', false);
      if (status === 'published') q = q.eq('is_published', true);
      if (audience) q = q.eq('audience', audience);
      if (tag) q = q.contains('tags', [tag]);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return jsonResult({ docs: data ?? [] });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_get — read one (full body)
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_get',
    'Fetch one help_doc by UUID, including the full body. Use during review.',
    { id: z.string().uuid() },
    withAudit(ctx, 'help_docs_get', 'read:help_docs', async ({ id }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .from('help_docs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return jsonResult({ ok: false, error: 'not found' });
      return jsonResult({ ok: true, doc: data });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_publish / help_docs_unpublish — review gate
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_publish',
    'Flip is_published=true on a help_doc. After this it becomes visible to authenticated operators (operator audience) and queryable from Henry. Requires admin:help_docs scope.',
    { id: z.string().uuid() },
    withAudit(ctx, 'help_docs_publish', 'admin:help_docs', async ({ id }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .from('help_docs')
        .update({ is_published: true })
        .eq('id', id)
        .is('archived_at', null)
        .select('id, audience')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return jsonResult({ ok: false, error: 'not found or archived' });
      return jsonResult({ ok: true, id, audience: data.audience, is_published: true });
    }),
  );

  server.tool(
    'help_docs_unpublish',
    'Flip is_published=false on a help_doc. Use to pull a doc back to draft status without archiving it. Requires admin:help_docs scope.',
    { id: z.string().uuid() },
    withAudit(ctx, 'help_docs_unpublish', 'admin:help_docs', async ({ id }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .from('help_docs')
        .update({ is_published: false })
        .eq('id', id)
        .is('archived_at', null)
        .select('id')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return jsonResult({ ok: false, error: 'not found or archived' });
      return jsonResult({ ok: true, id, is_published: false });
    }),
  );

  // ──────────────────────────────────────────────────────────────────
  // help_docs_archive — soft delete
  // ──────────────────────────────────────────────────────────────────
  server.tool(
    'help_docs_archive',
    'Soft-delete (sets archived_at). Hides from search + operator visibility; row + embedding preserved for audit.',
    { id: z.string().uuid() },
    withAudit(ctx, 'help_docs_archive', 'write:help_docs', async ({ id }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .from('help_docs')
        .update({ archived_at: new Date().toISOString() })
        .eq('id', id)
        .is('archived_at', null)
        .select('id')
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return jsonResult({ ok: false, error: 'not found or already archived' });
      return jsonResult({ ok: true, id });
    }),
  );
}
