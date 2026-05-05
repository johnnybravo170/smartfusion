/**
 * Slim LLM client for ops (board engine + future ops AI features).
 *
 * Why ops-local instead of @/lib/ai-gateway:
 *   - ops can't reach the main app's `@/*` path alias (separate tsconfig).
 *   - Board has self-contained cost tracking on board_messages.cost_cents,
 *     not the public.ai_calls table the gateway writes to.
 *   - We need OpenRouter for Kimi A/B; the main gateway doesn't have it.
 *
 * Two providers ship today: Anthropic (direct, with prompt caching for the
 * Jonathan imprint) and OpenRouter (covers Kimi, Gemini, etc). Add more by
 * implementing LlmProvider and wiring into dispatch().
 */

export type LlmProviderName = 'anthropic' | 'openrouter';

export type LlmMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type LlmCacheBlock = {
  /** Marks this system block as cacheable. Anthropic respects it directly;
   *  OpenRouter passes the hint through to upstreams that support it. */
  cache: true;
  text: string;
};

export type LlmSystemBlock = string | { text: string; cache?: boolean };

export type LlmRequest = {
  /** Sonnet, Kimi, etc. Provider-specific identifier. */
  model: string;
  /** System prompt. Pass an array to mark cache breakpoints (Anthropic only,
   *  but the contract is portable: non-supporting providers concatenate). */
  system?: LlmSystemBlock | LlmSystemBlock[];
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
  /** When set, the provider is asked for JSON output. The text is parsed by
   *  the caller (we don't enforce a schema here since each board call has a
   *  different shape and zod runs at the call site). */
  json?: boolean;
  /** Per-call timeout. Defaults to 120s. */
  timeout_ms?: number;
};

export type LlmResponse = {
  provider: LlmProviderName;
  model: string;
  text: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_cents: number; // session-level cost cap is small ($5), cents is fine
  latency_ms: number;
};

export interface LlmProvider {
  readonly name: LlmProviderName;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public readonly provider: LlmProviderName,
    public readonly status?: number,
    public readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

/** Cost in cents for `tokens` against (input, output) USD per million. */
export function tokensToCents(
  tokens_in: number,
  tokens_out: number,
  in_per_m: number,
  out_per_m: number,
): number {
  const usd = (tokens_in / 1_000_000) * in_per_m + (tokens_out / 1_000_000) * out_per_m;
  return Math.round(usd * 100 * 100) / 100; // 2-decimal cents
}
