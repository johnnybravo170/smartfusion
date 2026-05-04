/**
 * Public types for the AI gateway. The `AiProvider` interface is what
 * each adapter implements; the router and callers speak only to this
 * surface.
 *
 * Cost is denominated in micros (millionths of a cent) because Gemini
 * Flash inputs cost on the order of $0.075 per 1M tokens — well below
 * a cent per call. Bigint avoids float drift on cumulative spend
 * tracked in the `ai_calls` telemetry table.
 *
 * Tool-use IS supported (the Anthropic adapter uses it under the hood
 * for `runStructured` to enforce schemas server-side). Streaming and
 * client-driven function-calling are NOT — no caller needs them.
 */

import type { ProviderName } from './errors';
import type { KnownTask } from './tasks';

// ---------------------------------------------------------------------------
// Common request shape
// ---------------------------------------------------------------------------

/**
 * Fields every gateway request carries. The `task` is the lookup key
 * for routing config and the attribution dimension in telemetry. It's
 * `string` (not the strict union) so callers can add new tasks without
 * coordinated type changes — unrecognized tasks fall through to the
 * default routing policy.
 */
export type AiRequestBase = {
  /** What this call is for. See `KnownTask` for the registered list. */
  task: KnownTask | (string & {});
  /** Tenant scope for telemetry isolation. Null for system / cron jobs. */
  tenant_id?: string | null;
  /** Force a specific provider. Skips the router and the fallback
   *  chain; the call must succeed on this provider or throw. Used by
   *  intake.ts for the operator's model-choice toggle, by tests for
   *  deterministic dispatch, and for incident pinning. */
  provider_override?: ProviderName;
  /** Force a specific model. Adapter-defaults are used when omitted. */
  model_override?: string;
  /** Per-call timeout in milliseconds. Adapters apply via AbortSignal. */
  timeout_ms?: number;
};

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type ChatRequest = AiRequestBase & {
  kind: 'chat';
  /** Optional system prompt. Mapped to each provider's equivalent. */
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
};

export type AttachedFile = {
  /** MIME type, e.g. 'image/jpeg' or 'application/pdf'. */
  mime: string;
  /** Base64-encoded file contents. Adapters convert to provider format. */
  base64: string;
  /** Optional filename — used by some providers for hints. */
  filename?: string;
};

export type VisionRequest = AiRequestBase & {
  kind: 'vision';
  /** Instruction describing what to extract. */
  prompt: string;
  /** Single inline file. For multi-file requests use `files`. */
  file?: AttachedFile;
  /** Multiple files (e.g. audio + photos). Adapters concatenate in order. */
  files?: AttachedFile[];
  max_tokens?: number;
};

/**
 * Audio transcription. Used for voice memos, intake recordings, etc.
 *
 * Provider support: OpenAI only at the moment (Whisper / gpt-4o-transcribe).
 * Gemini and Anthropic accept inline audio via their multimodal endpoints
 * but don't expose a dedicated transcription primitive — for those use
 * `runStructured` with an audio file in `files`. Routing for any
 * transcription task should pin to OpenAI (no fallback).
 */
export type TranscribeRequest = AiRequestBase & {
  kind: 'transcribe';
  /** Audio file (mp3, mp4, m4a, wav, webm, ogg, flac). */
  file: AttachedFile;
  /** Domain-specific prompt. Improves accuracy on technical terms. */
  prompt?: string;
  /** ISO-639-1 language hint (e.g. 'en'). Defaults to auto-detect. */
  language?: string;
};

export type TranscribeResponse = AiResponseBase & {
  kind: 'transcribe';
  text: string;
};

/**
 * JSON-mode structured output. The schema is provider-portable JSON
 * Schema. `parse` runs after the provider returns; throwing inside
 * `parse` produces an `invalid_input` AiError.
 */
export type StructuredRequest<T = unknown> = AiRequestBase & {
  kind: 'structured';
  prompt: string;
  /** JSON Schema describing the response. Adapter maps to provider format. */
  schema: Record<string, unknown>;
  /** Optional inline file (vision + structured combined — receipt OCR uses this). */
  file?: AttachedFile;
  /** Multiple files (e.g. audio transcript + photos for project memos). */
  files?: AttachedFile[];
  /** Validates the parsed JSON. Defaults to identity cast. */
  parse?: (raw: unknown) => T;
  temperature?: number;
  max_tokens?: number;
  /**
   * Enable extended thinking on providers that support it (Anthropic only
   * today). `budget_tokens` must be ≥1024 and less than `max_tokens`.
   * Adapters that don't support thinking ignore this field. When set, the
   * Anthropic adapter forces `temperature: 1` and switches forced
   * tool-choice to `any` — both required by extended thinking + tool use.
   */
  thinking?: { budget_tokens: number };
};

// ---------------------------------------------------------------------------
// Common response shape
// ---------------------------------------------------------------------------

/**
 * Telemetry-bearing fields every response carries. The router's
 * telemetry hook logs these to `ai_calls`; the admin dashboard reads
 * them back at /admin/ai-gateway.
 */
export type AiResponseBase = {
  provider: ProviderName;
  model: string;
  /** Multi-key support: which configured key/project served the call.
   *  Opaque label set in env. Lets us slice cost by HeyHenry-org vs
   *  personal-org once we split. */
  api_key_label: string;
  tokens_in: number;
  tokens_out: number;
  /** Cost in millionths of a cent. Use bigint to avoid float drift on
   *  cumulative spend (a busy tenant racks up ≥ 2^31 micros / month). */
  cost_micros: bigint;
  latency_ms: number;
};

export type ChatResponse = AiResponseBase & {
  kind: 'chat';
  text: string;
};

export type VisionResponse = AiResponseBase & {
  kind: 'vision';
  text: string;
};

export type StructuredResponse<T = unknown> = AiResponseBase & {
  kind: 'structured';
  data: T;
  /** Raw text the provider returned, before JSON.parse. Useful for
   *  debugging schema-mismatch failures. */
  raw_text: string;
};

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface AiProvider {
  readonly name: ProviderName;
  callChat(req: ChatRequest): Promise<ChatResponse>;
  callVision(req: VisionRequest): Promise<VisionResponse>;
  callStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;
  callTranscribe(req: TranscribeRequest): Promise<TranscribeResponse>;
}
