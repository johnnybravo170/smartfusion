import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { contentHash, embedText } from '@/lib/embed';
import { createServiceClient } from '@/lib/supabase';

const createSchema = z.object({
  actor_name: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(100000),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional().default([]),
});

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:knowledge' });
  if (!auth.ok) return auth.response;

  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('knowledge_docs')
    .insert({
      actor_type: 'agent',
      actor_name: parsed.data.actor_name,
      title: parsed.data.title,
      body: parsed.data.body,
      tags: parsed.data.tags,
    })
    .select('id, title, body')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Insert failed' }, { status: 500 });
  }

  // Embed async — return the doc ID immediately, embedding runs server-side.
  try {
    const textForEmbed = `${data.title}\n\n${data.body}`;
    const [vector, hash] = await Promise.all([embedText(textForEmbed), contentHash(textForEmbed)]);
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
    // Doc is saved; embedding failed. Still return ok so caller can retry.
    const url = new URL(req.url);
    await logAuditSuccess(
      auth.key.id,
      'POST',
      url.pathname + url.search,
      200,
      auth.key.ip,
      req.headers.get('user-agent'),
      auth.bodySha,
      auth.reason,
    );
    return NextResponse.json({
      ok: true,
      id: data.id,
      warning: `Saved but embedding failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const url = new URL(req.url);
  await logAuditSuccess(
    auth.key.id,
    'POST',
    url.pathname + url.search,
    200,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );

  return NextResponse.json({ ok: true, id: data.id });
}
