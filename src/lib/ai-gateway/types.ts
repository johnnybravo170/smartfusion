/**
 * Public types for the AI gateway. The `AiProvider` interface is what
 * each adapter (AG-2) implements; the router (AG-3) and callers (AG-7)
 * speak only to this surface.
 *
 * Cost is denominated in micros (millionths of a cent) because Gemini
 * Flash inputs cost on the order of $0.075 per 1M tokens — well below
 * a cent per call. Bigint avoids float drift on cumulative spend
 * tracked in the telemetry table (AG-5).
 *
 * Streaming, tool-use, and function calling are intentionally not in
 * the v1 surface — no current HeyHenry caller uses them. Added later
 * once a feature actually needs them.
 */

import type { ProviderName } from './errors';
import type { KnownTask } from './tasks';

// ---------------------------------------------------------------------------
// Common request shape
// ---------------------------------------------------------------------------

/**
 * Fields every gateway request carries. The `task` is the lookup key
 * for routing (AG-3) and the attribution dimension in telemetry (AG-5).
 * It's `string` (not the strict union) so callers can add new tasks
 * without coordinated type changes — unrecognized tasks fall through
 * to the default routing policy.
 */
export type AiRequestBase = {
  /** What this call is for. See `KnownTask` for the registered list. */
  task: KnownTask | (string & {});
  /** Tenant scope for telemetry isolation. Null for system / cron jobs. */
  tenant_id?: string | null;
  /** Force a specific provider. Skips the router; useful for incident
   *  pinning and tests. */
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
  file: AttachedFile;
  max_tokens?: number;
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
  /** Validates the parsed JSON. Defaults to identity cast. */
  parse?: (raw: unknown) => T;
  temperature?: number;
};

// ---------------------------------------------------------------------------
// Common response shape
// ---------------------------------------------------------------------------

/**
 * Telemetry-bearing fields every response carries. AG-5 logs these to
 * `ai_calls`; AG-8 surfaces them on the admin dashboard.
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
}
