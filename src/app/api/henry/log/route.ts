/**
 * POST /api/henry/log
 *
 * Records a completed Henry turn (user question + assistant response + tool
 * calls + usage metrics). Called from the browser at `turnComplete` so we can
 * build analytics + usage-based billing later.
 *
 * Writes a single row into henry_interactions under the authenticated tenant.
 * Service role is used to insert because tenants don't have direct INSERT via
 * RLS — we validate the tenant here in the route.
 */

import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

type LogBody = {
  conversationId?: string;
  userText?: string;
  assistantText?: string;
  toolCalls?: Array<Record<string, unknown>>;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  audioInputSeconds?: number;
  audioOutputSeconds?: number;
  durationMs?: number;
  error?: string;
};

export async function POST(request: Request) {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const user = await getCurrentUser();

  let body: LogBody;
  try {
    body = (await request.json()) as LogBody;
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { error } = await supabase.from('henry_interactions').insert({
    tenant_id: tenant.id,
    user_id: user?.id ?? null,
    conversation_id: body.conversationId ?? null,
    vertical: tenant.vertical,
    user_text: body.userText ?? null,
    assistant_text: body.assistantText ?? null,
    tool_calls: body.toolCalls ?? [],
    model: body.model ?? null,
    provider: body.provider ?? null,
    input_tokens: body.inputTokens ?? null,
    output_tokens: body.outputTokens ?? null,
    cached_input_tokens: body.cachedInputTokens ?? null,
    audio_input_seconds: body.audioInputSeconds ?? null,
    audio_output_seconds: body.audioOutputSeconds ?? null,
    duration_ms: body.durationMs ?? null,
    error: body.error ?? null,
  });

  if (error) {
    console.error('[Henry log] insert failed:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
