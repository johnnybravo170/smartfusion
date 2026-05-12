/**
 * POST /api/henry/session
 *
 * Returns session credentials for Henry's real-time voice session.
 * The provider is selected by the HENRY_VOICE_PROVIDER env var:
 *
 *   openai (default) → mints an ephemeral OpenAI client_secret; browser
 *                       connects directly to wss://api.openai.com/v1/realtime
 *   gemini           → returns a proxyUrl; browser connects to our
 *                       /api/henry/gemini-proxy Pages Router WS handler
 *   auto             → tries OpenAI first; falls back to Gemini on any mint
 *                       failure (tier limits, key rotation, outage)
 *
 * Response shape: SessionInitResponse from src/lib/henry/providers/types.ts
 */

import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { allTools } from '@/lib/ai/tools';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { clientRealtimeTools, toOpenAIRealtimeTools } from '@/lib/henry/openai-tools';

const REALTIME_MODEL = process.env.HENRY_OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2';

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    if (!tenant) {
      const user = await getCurrentUser();
      const reason = user ? 'no_tenant_for_user' : 'no_user';
      return Response.json({ error: 'Unauthorized', reason }, { status: 401 });
    }

    const preference = (process.env.HENRY_VOICE_PROVIDER ?? 'openai') as
      | 'openai'
      | 'gemini'
      | 'auto';

    // ── Gemini-only ──────────────────────────────────────────────────────
    if (preference === 'gemini') {
      return buildGeminiResponse();
    }

    // ── OpenAI-only ──────────────────────────────────────────────────────
    if (preference === 'openai') {
      const result = await tryMintOpenAI(tenant);
      if (result.ok) return Response.json(result.payload);
      return Response.json({ error: result.error }, { status: 502 });
    }

    // ── Auto: try OpenAI, fall back to Gemini ────────────────────────────
    const result = await tryMintOpenAI(tenant);
    if (result.ok) return Response.json(result.payload);
    console.warn('[Henry session] OpenAI mint failed, falling back to Gemini:', result.error);
    return buildGeminiResponse();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Henry session] unexpected failure:', msg, e);
    return Response.json({ error: `Session route crashed: ${msg}` }, { status: 500 });
  }
}

// ─── OpenAI mint helper ──────────────────────────────────────────────────────

type OpenAIMintResult =
  | { ok: true; payload: { provider: 'openai'; clientSecret: string; model: string } }
  | { ok: false; error: string };

async function tryMintOpenAI(
  tenant: Awaited<ReturnType<typeof getCurrentTenant>>,
): Promise<OpenAIMintResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: 'Server missing OPENAI_API_KEY' };
  if (!tenant) return { ok: false, error: 'No tenant' };

  const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
  const tools = [...toOpenAIRealtimeTools(allTools), ...clientRealtimeTools];

  try {
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
          output_modalities: ['audio'],
          tools,
          tool_choice: 'auto',
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              transcription: { model: 'gpt-4o-transcribe', language: 'en' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 300,
                silence_duration_ms: 500,
                create_response: true,
                interrupt_response: true,
              },
            },
            output: {
              format: { type: 'audio/pcm', rate: 24000 },
              voice: 'cedar',
            },
          },
        },
      }),
    });

    if (!mintRes.ok) {
      const body = await mintRes.text();
      console.error('[Henry session] mint failed:', mintRes.status, body);
      return { ok: false, error: `OpenAI client_secret mint ${mintRes.status}: ${body}` };
    }

    const minted = (await mintRes.json()) as { value?: string; expires_at?: number };
    if (!minted.value) {
      return { ok: false, error: 'client_secret response missing value' };
    }

    return {
      ok: true,
      payload: { provider: 'openai', clientSecret: minted.value, model: REALTIME_MODEL },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Gemini proxy URL builder ────────────────────────────────────────────────

function buildGeminiResponse(): Response {
  if (!process.env.GEMINI_API_KEY) {
    return Response.json({ error: 'GEMINI_API_KEY not configured' }, { status: 503 });
  }

  // Derive the WebSocket URL for the proxy from the app's public URL.
  // In development this is ws://localhost:3000; on Vercel it's wss://<domain>.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
  const proxyUrl =
    appUrl
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')
      .replace(/\/$/, '') + '/api/henry/gemini-proxy';

  return Response.json({ provider: 'gemini', proxyUrl });
}
