/**
 * Provider abstraction for Henry's real-time voice session.
 *
 * Both OpenAI Realtime and Gemini Live implement `RealtimeSession`.
 * The hook (`use-henry.ts`) is provider-agnostic and only speaks this
 * interface — all wire-protocol details live in the concrete classes.
 *
 * Provider selection:
 *   HENRY_VOICE_PROVIDER=openai  → OpenAIRealtimeSession (browser→api.openai.com direct)
 *   HENRY_VOICE_PROVIDER=gemini  → GeminiProxySession    (browser→/pages/api/henry/gemini-proxy)
 *   HENRY_VOICE_PROVIDER=auto    → try OpenAI, fall back to Gemini on any mint failure
 */

export type VoiceProvider = 'openai' | 'gemini';

// ─── Events emitted by providers upward to use-henry.ts ─────────────────────

export type ProviderEvent =
  // Session lifecycle
  | { type: 'session.ready' }
  | { type: 'session.error'; message: string; fatal: boolean }

  // VAD state machine (voice activity detection)
  | { type: 'vad.speech_started' }
  | { type: 'vad.speech_stopped' }

  // User input transcript (streamed as it arrives)
  | { type: 'transcript.user.delta'; delta: string }
  | { type: 'transcript.user.done' }

  // Assistant response
  | { type: 'response.started' }
  | { type: 'audio.delta'; base64Pcm: string }
  | { type: 'audio.done' }
  | { type: 'transcript.assistant.delta'; delta: string }
  | { type: 'transcript.assistant.done' }

  // Tool calling (one event per function call)
  | { type: 'tool.call'; callId: string; name: string; argsJson: string }

  // Response completion
  | { type: 'response.done' };

// ─── Commands sent from use-henry.ts down to providers ──────────────────────

export type ProviderCommand =
  | { type: 'audio.append'; base64Pcm: string }
  | { type: 'tool.result'; callId: string; output: string; isError: boolean }
  | { type: 'text.send'; text: string; audioResponse: boolean }
  | { type: 'response.cancel' };

// ─── The interface both providers implement ──────────────────────────────────

export interface RealtimeSession {
  readonly provider: VoiceProvider;
  readonly isConnected: boolean;

  /**
   * Establish the connection.
   * Resolves when the session is ready to accept audio (after `session.ready`).
   * Rejects on fatal setup errors.
   */
  connect(): Promise<void>;

  /** Tear down the session gracefully. Should not throw. */
  disconnect(): void;

  /** Send a command. Fire-and-forget; errors surface via onEvent. */
  send(cmd: ProviderCommand): void;

  /** Register the hook's event handler. Called once after construction. */
  onEvent(handler: (evt: ProviderEvent) => void): void;
}

// ─── Shape returned by POST /api/henry/session ──────────────────────────────

export type SessionInitResponse =
  | { provider: 'openai'; clientSecret: string; model: string }
  | { provider: 'gemini'; proxyUrl: string };
