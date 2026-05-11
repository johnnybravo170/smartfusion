'use client';

/**
 * Gemini Live provider — browser side.
 *
 * Connects to our server-side WebSocket proxy at /api/henry/gemini-proxy
 * (a Pages Router API route that uses the @google/genai Live SDK server-side,
 * keeping the GEMINI_API_KEY off the browser).
 *
 * The proxy speaks a simple JSON envelope protocol over the WebSocket.
 * Audio is PCM16 base64 at 16kHz (Gemini Live input requirement).
 * Output audio from the proxy is also PCM16 base64 (at the rate Gemini returns,
 * typically 24kHz for native-audio models).
 *
 * ⚠ Vercel deployment note: Pages Router API routes with Node.js runtime support
 * WebSocket upgrade via req.socket. Validate this works on your Vercel plan
 * before relying on it in production. If it doesn't, move the proxy to a
 * separate long-running service (Fly.io, Railway) and update proxyUrl accordingly.
 */

import type { ProviderCommand, ProviderEvent, RealtimeSession } from './types';

// Messages from our proxy → browser
type ProxyToBrowser =
  | { type: 'ready' }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'vad_speech_started' }
  | { type: 'vad_speech_stopped' }
  | { type: 'audio'; data: string }
  | { type: 'audio_done' }
  | { type: 'user_transcript_delta'; delta: string }
  | { type: 'user_transcript_done' }
  | { type: 'assistant_transcript_delta'; delta: string }
  | { type: 'assistant_transcript_done' }
  | { type: 'tool_call'; callId: string; name: string; argsJson: string }
  | { type: 'response_done' };

// Messages from browser → proxy
type BrowserToProxy =
  | { type: 'audio'; data: string }
  | { type: 'tool_result'; callId: string; output: string; isError: boolean }
  | { type: 'text'; text: string; audioResponse: boolean }
  | { type: 'cancel' };

export class GeminiProxySession implements RealtimeSession {
  readonly provider = 'gemini' as const;

  private ws: WebSocket | null = null;
  private handler: ((evt: ProviderEvent) => void) | null = null;

  constructor(private readonly proxyUrl: string) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(handler: (evt: ProviderEvent) => void): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    const ws = new WebSocket(this.proxyUrl);
    this.ws = ws;

    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data as string) as ProxyToBrowser;
        const mapped = this.mapProxyEvent(data);
        if (mapped) this.handler?.(mapped);
      } catch {
        // Ignore unparseable frames.
      }
    };

    ws.onerror = () => {
      this.handler?.({ type: 'session.error', message: 'Gemini proxy error', fatal: true });
    };

    ws.onclose = (e) => {
      this.ws = null;
      const isAbnormal = e.code !== 1000 && e.code !== 1005;
      if (isAbnormal) {
        this.handler?.({
          type: 'session.error',
          message: 'Voice disconnected. Tap the mic to resume.',
          fatal: true,
        });
      }
    };

    // Wait for the proxy to confirm the Gemini session is up.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener('message', onMsg);
        ws.removeEventListener('error', onErr);
        ws.removeEventListener('close', onClose);
      };
      const onMsg = (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data as string) as ProxyToBrowser;
          if (d.type === 'ready') {
            cleanup();
            resolve();
          }
          if (d.type === 'error' && d.fatal) {
            cleanup();
            reject(new Error(d.message));
          }
        } catch {
          /* ok */
        }
      };
      const onErr = () => {
        cleanup();
        reject(new Error('Gemini proxy WS errored before ready'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Gemini proxy WS closed before ready'));
      };
      ws.addEventListener('message', onMsg);
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('close', onClose, { once: true });
      setTimeout(() => {
        cleanup();
        reject(new Error('Gemini proxy connect timeout (10s)'));
      }, 10_000);
    });
  }

  disconnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.rawSend({ type: 'cancel' });
    }
    this.ws?.close(1000);
    this.ws = null;
  }

  send(cmd: ProviderCommand): void {
    if (!this.isConnected) return;
    switch (cmd.type) {
      case 'audio.append':
        this.rawSend({ type: 'audio', data: cmd.base64Pcm });
        break;
      case 'tool.result':
        this.rawSend({
          type: 'tool_result',
          callId: cmd.callId,
          output: cmd.output,
          isError: cmd.isError,
        });
        break;
      case 'text.send':
        this.rawSend({ type: 'text', text: cmd.text, audioResponse: cmd.audioResponse });
        break;
      case 'response.cancel':
        this.rawSend({ type: 'cancel' });
        break;
    }
  }

  private rawSend(msg: BrowserToProxy): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private mapProxyEvent(d: ProxyToBrowser): ProviderEvent | null {
    switch (d.type) {
      case 'ready':
        return { type: 'session.ready' };
      case 'error':
        return { type: 'session.error', message: d.message, fatal: d.fatal };
      case 'vad_speech_started':
        return { type: 'vad.speech_started' };
      case 'vad_speech_stopped':
        return { type: 'vad.speech_stopped' };
      case 'audio':
        return { type: 'audio.delta', base64Pcm: d.data };
      case 'audio_done':
        return { type: 'audio.done' };
      case 'user_transcript_delta':
        return { type: 'transcript.user.delta', delta: d.delta };
      case 'user_transcript_done':
        return { type: 'transcript.user.done' };
      case 'assistant_transcript_delta':
        return { type: 'transcript.assistant.delta', delta: d.delta };
      case 'assistant_transcript_done':
        return { type: 'transcript.assistant.done' };
      case 'tool_call':
        return { type: 'tool.call', callId: d.callId, name: d.name, argsJson: d.argsJson };
      case 'response_done':
        return { type: 'response.done' };
      default:
        return null;
    }
  }
}
