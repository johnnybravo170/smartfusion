'use client';

/**
 * OpenAI Realtime provider.
 *
 * Wraps the OpenAI Realtime WebSocket protocol and translates it into the
 * provider-agnostic `ProviderEvent` / `ProviderCommand` interface so that
 * `use-henry.ts` stays completely provider-agnostic.
 *
 * Connection flow:
 *   1. Caller fetches POST /api/henry/session → { provider:'openai', clientSecret, model }
 *   2. Constructs OpenAIRealtimeSession(clientSecret, model)
 *   3. Calls session.connect() — opens WS, waits for session.created
 *   4. Sends audio via session.send({ type: 'audio.append', base64Pcm })
 */

import type { ProviderCommand, ProviderEvent, RealtimeSession } from './types';

// Subset of OpenAI Realtime server events we actually handle.
type ServerEvent =
  | { type: 'session.created' | 'session.updated' }
  | { type: 'error'; error?: { message?: string; code?: string } }
  | { type: 'input_audio_buffer.speech_started' }
  | { type: 'input_audio_buffer.speech_stopped' }
  | { type: 'conversation.item.input_audio_transcription.delta'; delta?: string }
  | { type: 'conversation.item.input_audio_transcription.completed' }
  | { type: 'response.created' }
  | { type: 'response.output_audio.delta'; delta?: string }
  | { type: 'response.output_audio.done' }
  | { type: 'response.output_audio_transcript.delta'; delta?: string }
  | { type: 'response.output_audio_transcript.done' }
  | { type: 'response.output_text.delta'; delta?: string }
  | { type: 'response.output_text.done' }
  | {
      type: 'response.function_call_arguments.done';
      call_id?: string;
      name?: string;
      arguments?: string;
    }
  | { type: 'response.done' }
  | { type: string };

export class OpenAIRealtimeSession implements RealtimeSession {
  readonly provider = 'openai' as const;

  private ws: WebSocket | null = null;
  private handler: ((evt: ProviderEvent) => void) | null = null;

  constructor(
    private readonly clientSecret: string,
    private readonly model: string,
  ) {}

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  onEvent(handler: (evt: ProviderEvent) => void): void {
    this.handler = handler;
  }

  async connect(): Promise<void> {
    if (this.ws) return;

    const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
    // The ephemeral client_secret is passed via subprotocol — OpenAI's documented
    // mechanism for browser WebSocket connections where headers can't be set.
    const ws = new WebSocket(url, ['realtime', `openai-insecure-api-key.${this.clientSecret}`]);
    this.ws = ws;

    ws.onmessage = (msg) => {
      try {
        const evt = JSON.parse(msg.data as string) as ServerEvent;
        const mapped = this.mapEvent(evt);
        if (mapped) this.handler?.(mapped);
      } catch {
        // Ignore unparseable frames.
      }
    };

    ws.onerror = () => {
      this.handler?.({ type: 'session.error', message: 'Realtime connection error', fatal: true });
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

    // Wait for session.created before resolving — events sent before this
    // are silently dropped by the server.
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.removeEventListener('message', onMsg);
        ws.removeEventListener('error', onErr);
        ws.removeEventListener('close', onClose);
      };
      const onMsg = (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data as string) as { type?: string };
          if (parsed.type === 'session.created' || parsed.type === 'session.updated') {
            cleanup();
            resolve();
          }
        } catch {
          // handleServerEvent owns parse-error logging.
        }
      };
      const onErr = () => {
        cleanup();
        reject(new Error('Realtime WS errored before session.created'));
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Realtime WS closed before session.created'));
      };
      ws.addEventListener('message', onMsg);
      ws.addEventListener('error', onErr, { once: true });
      ws.addEventListener('close', onClose, { once: true });
    });
  }

  disconnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: 'response.cancel' }));
      } catch {
        /* ok */
      }
    }
    this.ws?.close();
    this.ws = null;
  }

  send(cmd: ProviderCommand): void {
    if (!this.isConnected) return;
    switch (cmd.type) {
      case 'audio.append':
        this.rawSend({ type: 'input_audio_buffer.append', audio: cmd.base64Pcm });
        break;

      case 'tool.result':
        // Send the function output then immediately request a new response.
        this.rawSend({
          type: 'conversation.item.create',
          item: { type: 'function_call_output', call_id: cmd.callId, output: cmd.output },
        });
        this.rawSend({ type: 'response.create' });
        break;

      case 'text.send':
        this.rawSend({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: cmd.text }],
          },
        });
        this.rawSend({
          type: 'response.create',
          response: { output_modalities: cmd.audioResponse ? ['audio'] : ['text'] },
        });
        break;

      case 'response.cancel':
        this.rawSend({ type: 'response.cancel' });
        break;
    }
  }

  private rawSend(evt: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(evt));
    }
  }

  private mapEvent(evt: ServerEvent): ProviderEvent | null {
    switch (evt.type) {
      case 'session.created':
      case 'session.updated':
        return { type: 'session.ready' };

      case 'error': {
        const msg = ('error' in evt && evt.error?.message) || 'Realtime error';
        const code = ('error' in evt && evt.error?.code) || '';
        const harmless = /no active response/i.test(msg) || code === 'response_cancel_not_active';
        if (harmless) return null;
        return { type: 'session.error', message: msg, fatal: false };
      }

      case 'input_audio_buffer.speech_started':
        return { type: 'vad.speech_started' };

      case 'input_audio_buffer.speech_stopped':
        return { type: 'vad.speech_stopped' };

      case 'conversation.item.input_audio_transcription.delta': {
        const delta = 'delta' in evt ? evt.delta : undefined;
        return delta ? { type: 'transcript.user.delta', delta } : null;
      }

      case 'conversation.item.input_audio_transcription.completed':
        return { type: 'transcript.user.done' };

      case 'response.created':
        return { type: 'response.started' };

      case 'response.output_audio.delta': {
        const delta = 'delta' in evt ? evt.delta : undefined;
        return delta ? { type: 'audio.delta', base64Pcm: delta } : null;
      }

      case 'response.output_audio.done':
        return { type: 'audio.done' };

      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        const delta = 'delta' in evt ? evt.delta : undefined;
        return delta ? { type: 'transcript.assistant.delta', delta } : null;
      }

      case 'response.output_audio_transcript.done':
      case 'response.output_text.done':
        return { type: 'transcript.assistant.done' };

      case 'response.function_call_arguments.done': {
        const callId = 'call_id' in evt ? evt.call_id : undefined;
        const name = 'name' in evt ? evt.name : undefined;
        const argsJson = 'arguments' in evt ? evt.arguments : undefined;
        if (!callId || !name) return null;
        return { type: 'tool.call', callId, name, argsJson: argsJson ?? '{}' };
      }

      case 'response.done':
        return { type: 'response.done' };

      default:
        return null;
    }
  }
}
