import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { contentHash, embedText } from '@/lib/embed';
import { createServiceClient } from '@/lib/supabase';
import { jsonResult, type McpToolCtx, withAudit } from './context';

export function registerKnowledgeTools(server: McpServer, ctx: McpToolCtx) {
  server.tool(
    'knowledge_search',
    'Semantic search over knowledge_docs. Use before writing anything new — the answer may already be saved. Returns hits ranked by cosine similarity.',
    {
      query: z.string().min(1).max(2000),
      limit: z.number().int().min(1).max(50).default(10),
      min_similarity: z.number().min(0).max(1).default(0.4),
    },
    withAudit(
      ctx,
      'knowledge_search',
      'read:knowledge',
      async ({ query, limit, min_similarity }) => {
        const service = createServiceClient();
        const vector = await embedText(query);
        const { data, error } = await service.schema('ops').rpc('knowledge_search', {
          query_embedding: vector,
          match_limit: limit,
          min_similarity,
        });
        if (error) throw new Error(error.message);
        return jsonResult({ hits: data ?? [] });
      },
    ),
  );

  server.tool(
    'knowledge_write',
    [
      'See ops_memory_guide for the full taxonomy.',
      '',
      'Evergreen facts Henry (the AI chat) and other agents should query forever. Semantic-searchable via pgvector. Use for: ICP definitions, product constraints, external API quirks, customer personas, pricing structures, naming conventions. Rule: the content must still be true in 6 months. DO NOT use for date-stamped events (\u2192 worklog_add) or choices-with-reasoning (\u2192 decisions_add).',
      '',
      'Save a new knowledge doc. Body is markdown. Embedding is computed server-side and stored alongside so future `knowledge_search` calls can find it. Tags are free-form.',
    ].join('\n'),
    {
      title: z.string().min(1).max(500),
      body: z.string().min(1).max(100000),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    },
    withAudit(ctx, 'knowledge_write', 'write:knowledge', async (input) => {
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from('knowledge_docs')
        .insert({
          actor_type: 'agent',
          actor_name: ctx.actorName,
          title: input.title,
          body: input.body,
          tags: input.tags ?? [],
        })
        .select('id, title, body')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'Insert failed');

      try {
        const text = `${data.title}\n\n${data.body}`;
        const [vector, hash] = await Promise.all([embedText(text), contentHash(text)]);
        await service.schema('ops').from('knowledge_embeddings').insert({
          doc_id: data.id,
          embedding: vector,
          content_hash: hash,
        });
        await service
          .schema('ops')
          .from('knowledge_docs')
          .update({ embedding_updated_at: new Date().toISOString() })
          .eq('id', data.id);
      } catch (e) {
        return jsonResult({
          ok: true,
          id: data.id,
          warning: `Saved but embedding failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return jsonResult({ ok: true, id: data.id });
    }),
  );

  server.tool(
    'knowledge_update',
    [
      'Patch an existing knowledge_doc by UUID. Only provided fields change.',
      'Re-embeds when `body` changes (title-only edits skip the embedding round-trip).',
      'Use this for rolling-state docs that get regenerated on a schedule, instead of letting `knowledge_write` accumulate duplicates.',
    ].join('\n'),
    {
      id: z.string().uuid(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().min(1).max(100000).optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
    },
    withAudit(ctx, 'knowledge_update', 'write:knowledge', async ({ id, ...input }) => {
      const service = createServiceClient();

      const { data: existing, error: fetchErr } = await service
        .schema('ops')
        .from('knowledge_docs')
        .select('id, title, body, archived_at')
        .eq('id', id)
        .maybeSingle();
      if (fetchErr) throw new Error(fetchErr.message);
      if (!existing) return jsonResult({ ok: false, error: 'not found' });
      if (existing.archived_at) return jsonResult({ ok: false, error: 'doc is archived' });

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (input.title !== undefined) patch.title = input.title;
      if (input.body !== undefined) patch.body = input.body;
      if (input.tags !== undefined) patch.tags = input.tags;
      if (Object.keys(patch).length === 1) {
        return jsonResult({ ok: true, id, changed: false });
      }

      const { error: updErr } = await service
        .schema('ops')
        .from('knowledge_docs')
        .update(patch)
        .eq('id', id);
      if (updErr) throw new Error(updErr.message);

      const bodyChanged = input.body !== undefined && input.body !== existing.body;
      if (bodyChanged) {
        try {
          const newTitle = input.title ?? (existing.title as string);
          const text = `${newTitle}\n\n${input.body as string}`;
          const [vector, hash] = await Promise.all([embedText(text), contentHash(text)]);
          await service.schema('ops').from('knowledge_embeddings').upsert(
            {
              doc_id: id,
              embedding: vector,
              content_hash: hash,
              updated_at: new Date().toISOString(),
            },
            { onConflict: 'doc_id' },
          );
          await service
            .schema('ops')
            .from('knowledge_docs')
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

  server.tool(
    'knowledge_delete',
    'Soft-delete a knowledge_doc (sets archived_at). Hides from `knowledge_search`; row + embedding preserved for audit.',
    { id: z.string().uuid() },
    withAudit(ctx, 'knowledge_delete', 'write:knowledge', async ({ id }) => {
      const service = createServiceClient();
      const { data, error } = await service
        .schema('ops')
        .from('knowledge_docs')
        .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
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
