/**
 * POST /api/henry/session
 *
 * Mints a short-lived Gemini Live ephemeral auth token plus the session config
 * (model, system prompt, tool declarations) the client needs to open a Live
 * WebSocket directly to Google.
 *
 * The ephemeral token keeps our GEMINI_API_KEY on the server. It's single-use
 * and expires within minutes; even if leaked it can't be reused.
 */

import { GoogleGenAI } from '@google/genai';
import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { allTools } from '@/lib/ai/tools';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { toGeminiFunctionDeclarations } from '@/lib/henry/adapter';

// Gemini Live 2.5 Flash preview: supports tool calling + audio in/out + transcripts.
// Model identifier per @google/genai SDK docstrings (Live.connect examples).
const LIVE_MODEL = 'gemini-live-2.5-flash-preview';

export async function POST() {
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'Server missing GEMINI_API_KEY' }, { status: 500 });
  }

  const ai = new GoogleGenAI({ apiKey });

  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      // One session worth of uses; resuming doesn't count.
      uses: 1,
      // Session may live up to 30 min once opened.
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),
      // Client has 60 seconds to open the socket after minting.
      newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    },
  });

  const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
  const tools = toGeminiFunctionDeclarations(allTools);

  return Response.json({
    token: token.name,
    model: LIVE_MODEL,
    systemPrompt,
    tools,
  });
}
