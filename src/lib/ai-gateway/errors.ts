/**
 * Normalized AI error class. Every adapter classifies its provider's
 * specific error format into one of these `kind` values so the router
 * (AG-3) and circuit breaker (AG-4) can act on a uniform signal.
 *
 * Design notes:
 *  - Thrown, not returned. The router uses try/catch + instanceof so it
 *    can distinguish AI failures from genuine bugs. Callers above the
 *    router (server actions) wrap and translate to the `{ ok, error }`
 *    discriminant per PATTERNS.md §5.
 *  - `retryable` is a hint — the router decides whether to walk the
 *    fallback chain based on `kind` AND its own policy. Don't make
 *    routing decisions in adapters.
 *  - `cause` preserves the original error for telemetry / debugging.
 */
export type AiErrorKind =
  /** Provider-account quota exhausted (e.g. OpenAI insufficient_quota,
   *  Gemini RESOURCE_EXHAUSTED). Trips the circuit breaker — fallback
   *  is the right move; retrying same provider won't help. */
  | 'quota'
  /** Transient overload (503 / Gemini UNAVAILABLE / OpenAI overloaded_error).
   *  Worth a retry on the same provider; if it persists, fall through. */
  | 'overload'
  /** 429 rate limit (per-key, not per-org quota). Backoff + retry on
   *  same provider; fall through after attempts. */
  | 'rate_limit'
  /** 400 / bad request — caller's payload is malformed. Don't retry, don't
   *  fall through. The fallback would just fail the same way. */
  | 'invalid_input'
  /** 401 / 403 — bad API key, deauthorized. Operator config issue.
   *  Don't retry; alert. */
  | 'auth'
  /** Network / fetch timeout. Retryable on same provider once, then
   *  fall through. */
  | 'timeout'
  /** Anything else. Treat as retryable + falling through to be safe. */
  | 'unknown';

export type ProviderName = 'openai' | 'gemini' | 'anthropic' | 'noop';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly provider: ProviderName;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly cause: unknown;

  constructor(input: {
    kind: AiErrorKind;
    provider: ProviderName;
    message: string;
    /** Defaults to a per-`kind` policy. Pass to override. */
    retryable?: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'AiError';
    this.kind = input.kind;
    this.provider = input.provider;
    this.retryable = input.retryable ?? defaultRetryable(input.kind);
    this.status = input.status;
    this.cause = input.cause;
  }
}

/**
 * Default retryability policy per error kind. Adapters can override
 * by passing `retryable` explicitly when they have provider-specific
 * insight (e.g. some 400s are transient).
 */
export function defaultRetryable(kind: AiErrorKind): boolean {
  switch (kind) {
    case 'quota':
      return true; // fallback chain, not same provider
    case 'overload':
      return true;
    case 'rate_limit':
      return true;
    case 'timeout':
      return true;
    case 'unknown':
      return true;
    case 'invalid_input':
      return false;
    case 'auth':
      return false;
  }
}

export function isAiError(err: unknown): err is AiError {
  return err instanceof AiError;
}
