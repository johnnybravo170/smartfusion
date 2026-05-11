/**
 * Gemini Live WebSocket proxy.
 *
 * Bridges the browser's WebSocket connection to a server-side Gemini Live
 * session. The GEMINI_API_KEY never reaches the browser — it lives here.
 *
 * Why Pages Router (not App Router):
 *   Next.js App Router route handlers use the Web Fetch API and don't expose
 *   the underlying TCP socket. Pages Router API routes receive Node.js
 *   IncomingMessage / ServerResponse which support WebSocket upgrade via
 *   req.socket. This is the established pattern for Next.js WebSocket support.
 *   Next 16's own docs confirm this is not portable — see
 *   node_modules/next/dist/docs/01-app/02-guides/backend-for-frontend.md:
 *   "WebSockets won't work because the connection closes on timeout, or after
 *   the response is generated."
 *
 * ⚠ Linked to next.config.ts (`typescript.ignoreBuildErrors`):
 *   This is the only file under `src/pages/`. Its existence triggers Next's
 *   pages-compat type augmentation in next-env.d.ts, which makes
 *   useSearchParams/useParams/usePathname return nullable across all
 *   app-router code. We work around that by skipping the typecheck inside
 *   `next build` (the standalone `pnpm typecheck` is the real gate). If this
 *   file ever moves out of src/pages/ — to a separate long-running service or
 *   a future Next.js WebSocket primitive — also revert
 *   `typescript.ignoreBuildErrors` in next.config.ts. They exist as a pair.
 *
 * ⚠ Vercel deployment validation:
 *   Pages Router API routes run as Node.js Serverless Functions on Vercel.
 *   WebSocket upgrade via req.socket works in local dev (next dev). On Vercel,
 *   the socket upgrade behavior depends on the runtime and plan:
 *   - Vercel Pro/Enterprise: Node.js functions support long-lived connections
 *     with maxDuration up to 800s, which is sufficient for voice sessions.
 *   - Test after first deploy: open voice session with HENRY_VOICE_PROVIDER=gemini
 *     and confirm audio flows bidirectionally.
 *   - If upgrade doesn't work on Vercel, move this handler to a separate
 *     long-running service (Fly.io, Railway) and update proxyUrl in session route.
 *
 * Protocol (browser ↔ proxy JSON envelopes):
 *   Browser → proxy: { type: 'audio'|'tool_result'|'text'|'cancel', ...fields }
 *   Proxy → browser: { type: 'ready'|'error'|'vad_*'|'audio'|'tool_call'|..., ...fields }
 *
 * Audio format:
 *   Input (browser→proxy→Gemini): PCM16 base64 at 16kHz mono
 *   Output (Gemini→proxy→browser): PCM16 base64 at 24kHz mono (native audio models)
 *
 * NOTE: The browser hook sends audio at the sample rate matching the active
 * provider (16kHz for Gemini, 24kHz for OpenAI). See use-henry.ts for the
 * SAMPLE_RATE selection logic.
 */

import { FunctionResponseScheduling, GoogleGenAI, Modality } from '@google/genai';
import type { IncomingMessage, ServerResponse } from 'http';
import { type WebSocket, WebSocketServer } from 'ws';
import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { allTools } from '@/lib/ai/tools';
import { getCurrentTenantFromReq } from '@/lib/auth/helpers-node';
import { toGeminiFunctionDeclarations } from '@/lib/henry/adapter';

// Gemini Live native-audio model. Check @google/genai release notes if this
// needs updating — model names for preview models change frequently.
const GEMINI_LIVE_MODEL = 'gemini-live-2.5-flash-preview';

// Tool names where Henry should keep talking while the tool runs in the
// background (SILENT), rather than waiting for the result before continuing.
const SILENT_TOOLS = new Set([
  'create_worklog_note',
  'log_time',
  'log_expense',
  'complete_todo',
  'add_worklog_entry',
]);

function getScheduling(toolName: string, isError: boolean): FunctionResponseScheduling {
  if (isError) return FunctionResponseScheduling.INTERRUPT;
  if (SILENT_TOOLS.has(toolName)) return FunctionResponseScheduling.SILENT;
  return FunctionResponseScheduling.WHEN_IDLE;
}

// Messages from browser → proxy
type BrowserToProxy =
  | { type: 'audio'; data: string }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean }
  | { type: 'text'; text: string; audioResponse: boolean }
  | { type: 'cancel' };

// Singleton WSS — created once per process, handles upgrade for this route.
let wss: WebSocketServer | null = null;

function getWss(): WebSocketServer {
  if (!wss) {
    // noServer=true: we handle the HTTP upgrade manually so we can validate
    // auth before accepting the socket.
    wss = new WebSocketServer({ noServer: true });
  }
  return wss;
}

function send(browser: WebSocket, msg: object): void {
  if (browser.readyState === browser.OPEN) {
    browser.send(JSON.stringify(msg));
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Only handle WebSocket upgrades.
  if (req.headers.upgrade?.toLowerCase() !== 'websocket') {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('Upgrade required');
    return;
  }

  // Auth: validate tenant before upgrading.
  const tenant = await getCurrentTenantFromReq(req);
  if (!tenant) {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('GEMINI_API_KEY not configured');
    return;
  }

  // Upgrade the HTTP connection to WebSocket.
  const server = getWss();
  server.handleUpgrade(req, req.socket, Buffer.alloc(0), async (browser) => {
    // Track pending tool call names (callId → toolName) so we can apply
    // scheduling when the tool result arrives from the browser.
    const pendingToolNames = new Map<string, string>();

    // Connect to Gemini Live.
    const ai = new GoogleGenAI({ apiKey });
    const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
    const toolDeclarations = toGeminiFunctionDeclarations(allTools);

    let geminiSession: Awaited<ReturnType<typeof ai.live.connect>> | null = null;

    try {
      geminiSession = await ai.live.connect({
        model: GEMINI_LIVE_MODEL,
        config: {
          systemInstruction: systemPrompt,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: [{ functionDeclarations: toolDeclarations as any }],
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } },
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: false },
          },
        },
        callbacks: {
          onopen: () => {
            send(browser, { type: 'ready' });
          },

          onmessage: (msg) => {
            // VAD: interrupted = user started speaking
            if (msg.serverContent?.interrupted) {
              send(browser, { type: 'vad_speech_started' });
            }

            // Audio output chunks
            const parts = msg.serverContent?.modelTurn?.parts ?? [];
            for (const part of parts) {
              if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/')) {
                send(browser, { type: 'audio', data: part.inlineData.data });
              }
              // Assistant text (transcript)
              if (part.text) {
                send(browser, { type: 'assistant_transcript_delta', delta: part.text });
              }
            }

            // Turn complete
            if (msg.serverContent?.turnComplete) {
              send(browser, { type: 'audio_done' });
              send(browser, { type: 'assistant_transcript_done' });
              send(browser, { type: 'response_done' });
            }

            // Input transcription (user speech → text)
            const inputTranscript = msg.serverContent?.inputTranscription?.text;
            if (inputTranscript) {
              send(browser, { type: 'user_transcript_delta', delta: inputTranscript });
            }

            // Tool calls — flatten the array (Gemini may batch multiple calls)
            const functionCalls = msg.toolCall?.functionCalls ?? [];
            for (const call of functionCalls) {
              if (!call.id || !call.name) continue;
              pendingToolNames.set(call.id, call.name);
              send(browser, {
                type: 'tool_call',
                callId: call.id,
                name: call.name,
                argsJson: JSON.stringify(call.args ?? {}),
              });
            }
          },

          onclose: () => {
            send(browser, { type: 'error', message: 'Gemini session closed', fatal: true });
            browser.close();
          },

          onerror: (err) => {
            console.error('[Gemini proxy] Gemini session error:', err);
            send(browser, { type: 'error', message: 'Gemini session error', fatal: true });
            browser.close();
          },
        },
      });
    } catch (err) {
      console.error('[Gemini proxy] Failed to connect to Gemini Live:', err);
      send(browser, {
        type: 'error',
        message: `Failed to start Gemini session: ${err instanceof Error ? err.message : String(err)}`,
        fatal: true,
      });
      browser.close();
      return;
    }

    // Relay browser → Gemini
    browser.on('message', (data) => {
      if (!geminiSession) return;
      let msg: BrowserToProxy;
      try {
        msg = JSON.parse(data.toString()) as BrowserToProxy;
      } catch {
        return;
      }

      switch (msg.type) {
        case 'audio':
          geminiSession.sendRealtimeInput({
            audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
          });
          break;

        case 'tool_result': {
          const toolName = pendingToolNames.get(msg.callId) ?? '';
          pendingToolNames.delete(msg.callId);
          const scheduling = getScheduling(toolName, msg.isError);
          geminiSession.sendToolResponse({
            functionResponses: [
              {
                id: msg.callId,
                name: toolName,
                response: { output: msg.output },
                scheduling,
              },
            ],
          });
          break;
        }

        case 'text':
          geminiSession.sendClientContent({
            turns: [{ role: 'user', parts: [{ text: msg.text }] }],
            turnComplete: true,
          });
          break;

        case 'cancel':
          // Gemini Live has no cancel primitive. Close and let the browser
          // reconnect — the session route will hand out a fresh proxyUrl.
          geminiSession.close();
          break;
      }
    });

    // Tear down Gemini session when browser disconnects.
    browser.on('close', () => {
      geminiSession?.close();
      geminiSession = null;
    });
  });
}

// Disable Next.js's default body parser — we handle the raw socket ourselves.
export const config = {
  api: {
    bodyParser: false,
  },
};
