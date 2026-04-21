/**
 * POST /api/henry/session
 *
 * Returns the Gemini Live session config (API key, model, system prompt, tool
 * declarations) the authenticated client needs to open a Live WebSocket.
 *
 * SECURITY — PRIVATE BETA ONLY:
 * We return the raw GEMINI_API_KEY to authenticated clients. Ephemeral tokens
 * (authTokens.create) mint successfully on AI Studio keys but force the Live
 * WebSocket to API version "v1main" where no Live model is registered, so the
 * socket closes with 1008 immediately. Until Google fixes that or we move to
 * Vertex AI, the pragmatic path is to expose the key.
 *
 * Mitigations: only authenticated tenants can hit this route; the key only
 * grants Gemini API access (not billing, not Google Cloud-wide).
 *
 * Before public launch we'll swap to a server-side WebSocket proxy so the key
 * never leaves the server. Tracked in HEY_HENRY_APP_PLAN.md.
 */

import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { allTools } from '@/lib/ai/tools';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { toGeminiFunctionDeclarations } from '@/lib/henry/adapter';
import { clientFunctionDeclarations } from '@/lib/henry/client-tools';

// gemini-2.5-flash-native-audio-preview-09-2025 was deprecated 2026-03-19
// and now hard-closes the Live socket with 1006 as of 2026-04-21. Forced
// onto 3.1-flash-live-preview (launched 2026-03-26).
//
// First 3.1 attempt added `thinkingConfig: { thinkingLevel: MINIMAL }` per
// the launch blog; responses were unusably slow. Theory: the SDK
// (@google/genai@1.50.1) or the Live backend doesn't honor MINIMAL and
// defaults to a higher thinking level. Removed the config — using the
// model's own defaults.
const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

export async function POST() {
  try {
    const tenant = await getCurrentTenant();
    if (!tenant) {
      // Distinguish "not signed in" from "signed in but no tenant" so the
      // client logs tell us which end of the chain failed.
      const user = await getCurrentUser();
      const reason = user ? 'no_tenant_for_user' : 'no_user';
      return Response.json({ error: 'Unauthorized', reason }, { status: 401 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return Response.json({ error: 'Server missing GEMINI_API_KEY' }, { status: 500 });
    }

    const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
    const tools = [...toGeminiFunctionDeclarations(allTools), ...clientFunctionDeclarations];

    return Response.json({
      token: apiKey,
      model: LIVE_MODEL,
      systemPrompt,
      tools,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Henry session] unexpected failure:', msg, e);
    return Response.json({ error: `Session route crashed: ${msg}` }, { status: 500 });
  }
}
