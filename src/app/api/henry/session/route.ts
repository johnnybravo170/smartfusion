/**
 * POST /api/henry/session
 *
 * Mints an ephemeral OpenAI Realtime client_secret, preconfigured with the
 * operator's system prompt + tool declarations. The browser opens a WebSocket
 * to the Realtime API using that secret; no server proxy needed.
 *
 * Why not the raw OPENAI_API_KEY: client_secrets expire in ~1 minute, so a
 * leak is a minute of risk instead of a permanent credential.
 *
 * Previously this route backed Gemini Live. Migrated to OpenAI Realtime on
 * 2026-04-21 after 2.5-native-audio was deprecated and 3.1-flash-live-preview
 * proved unusably slow.
 */

import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { allTools } from '@/lib/ai/tools';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { clientRealtimeTools, toOpenAIRealtimeTools } from '@/lib/henry/openai-tools';

const REALTIME_MODEL = 'gpt-realtime';

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    if (!tenant) {
      const user = await getCurrentUser();
      const reason = user ? 'no_tenant_for_user' : 'no_user';
      return Response.json({ error: 'Unauthorized', reason }, { status: 401 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: 'Server missing OPENAI_API_KEY' }, { status: 500 });
    }

    const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
    const tools = [...toOpenAIRealtimeTools(allTools), ...clientRealtimeTools];

    const mintRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: REALTIME_MODEL,
          instructions: systemPrompt,
          tools,
          tool_choice: 'auto',
          input_audio_transcription: { model: 'gpt-4o-transcribe' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true,
          },
        },
      }),
    });

    if (!mintRes.ok) {
      const body = await mintRes.text();
      console.error('[Henry session] mint failed:', mintRes.status, body);
      return Response.json(
        { error: `OpenAI client_secret mint ${mintRes.status}: ${body}` },
        { status: 500 },
      );
    }

    const minted = (await mintRes.json()) as { value?: string; expires_at?: number };
    if (!minted.value) {
      return Response.json({ error: 'client_secret response missing value' }, { status: 500 });
    }

    return Response.json({
      clientSecret: minted.value,
      model: REALTIME_MODEL,
      expiresAt: minted.expires_at ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Henry session] unexpected failure:', msg, e);
    return Response.json({ error: `Session route crashed: ${msg}` }, { status: 500 });
  }
}
