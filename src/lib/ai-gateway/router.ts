/**
 * The gateway router. Takes a typed request, picks a provider per the
 * routing config, walks the fallback chain on retryable errors, and
 * fires telemetry hooks on every attempt.
 *
 * Algorithm (per call):
 *   1. If `provider_override` is set → single attempt, no fallback.
 *   2. Else: weighted-random pick between primary and secondary.
 *   3. Try call → success: emit hook + return.
 *   4. AiError:
 *        - !retryable (auth / invalid_input) → emit hook + throw.
 *        - retryable → emit hook, mark provider as tried, walk
 *          `fallback_chain` skipping any already tried.
 *   5. All providers exhausted → throw the last error.
 *
 * Internal retries on the SAME provider for transient overload land in
 * AG-4 (circuit breaker + half-open). This module is intentionally
 * single-attempt-per-provider so the algorithm stays readable.
 */

import { CircuitBreaker } from './circuit-breaker';
import { AiError, isAiError, type ProviderName } from './errors';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { NoopProvider } from './providers/noop';
import { OpenAiProvider } from './providers/openai';
import type { RouteConfig, RoutePick, RouterHooks } from './router-types';
import { lookupRoute } from './routing';
import { createTelemetryHook } from './telemetry';
import type {
  AiProvider,
  ChatRequest,
  ChatResponse,
  StructuredRequest,
  StructuredResponse,
  TranscribeRequest,
  TranscribeResponse,
  VisionRequest,
  VisionResponse,
} from './types';

export type GatewayOptions = {
  providers?: Partial<Record<ProviderName, AiProvider>>;
  /** Override / extend per-task routing. Key wins over the default. */
  routing?: Record<string, RouteConfig>;
  hooks?: RouterHooks;
  /** Provide a custom breaker (tests can pass a clock). Defaults to a
   *  fresh one per Gateway. */
  breaker?: CircuitBreaker;
};

export class Gateway {
  private providers: Record<ProviderName, AiProvider | undefined>;
  private routing: Record<string, RouteConfig> | undefined;
  private hooks: RouterHooks | undefined;
  private breaker: CircuitBreaker;

  constructor(opts: GatewayOptions = {}) {
    this.providers = {
      openai: opts.providers?.openai ?? new OpenAiProvider(),
      gemini: opts.providers?.gemini ?? new GeminiProvider(),
      anthropic: opts.providers?.anthropic ?? new AnthropicProvider(),
      noop: opts.providers?.noop ?? new NoopProvider(),
    };
    this.routing = opts.routing;
    this.hooks = opts.hooks;
    this.breaker = opts.breaker ?? new CircuitBreaker();
  }

  async runChat(req: ChatRequest): Promise<ChatResponse> {
    return this.run(req, (p, pick) => p.callChat(applyRouteModel(req, pick)));
  }

  async runVision(req: VisionRequest): Promise<VisionResponse> {
    return this.run(req, (p, pick) => p.callVision(applyRouteModel(req, pick)));
  }

  async runStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    return this.run(req, (p, pick) => p.callStructured<T>(applyRouteModel(req, pick)));
  }

  async runTranscribe(req: TranscribeRequest): Promise<TranscribeResponse> {
    return this.run(req, (p, pick) => p.callTranscribe(applyRouteModel(req, pick)));
  }

  /**
   * Read-through to the breaker for the admin dashboard. Returns only
   * currently-open entries; empty array means "everything healthy."
   */
  openBreakers() {
    return this.breaker.openSnapshot();
  }

  // ------------------------------------------------------------------
  // Core orchestration
  // ------------------------------------------------------------------

  private async run<
    R extends {
      provider: ProviderName;
      model: string;
      api_key_label: string;
      tokens_in: number;
      tokens_out: number;
      cost_micros: bigint;
      latency_ms: number;
    },
  >(
    req: { task: string; tenant_id?: string | null; provider_override?: ProviderName },
    call: (provider: AiProvider, pick: RoutePick) => Promise<R>,
  ): Promise<R> {
    // Hard override path: single attempt, no fallback. No route lookup
    // either — caller takes full responsibility for model selection.
    if (req.provider_override) {
      const provider = this.providers[req.provider_override];
      if (!provider) {
        throw new AiError({
          kind: 'auth',
          provider: req.provider_override,
          message: `Provider "${req.provider_override}" not configured.`,
        });
      }
      const pick: RoutePick = { provider: req.provider_override };
      return this.attempt(req, provider, req.provider_override, 0, pick, call);
    }

    const route = lookupRoute(req.task, this.routing);
    const order = this.buildAttemptOrder(route);

    let lastError: unknown;
    let allSkippedByBreaker = true;
    for (let i = 0; i < order.length; i++) {
      const pick = order[i];
      const provider = this.providers[pick.provider];
      if (!provider) continue;
      // Breaker: if open for this provider, skip without firing the call.
      // We don't even emit a hook event for skipped attempts — they're
      // "we knew not to bother" rather than "we tried and failed."
      if (this.breaker.shouldSkip(pick.provider)) continue;
      allSkippedByBreaker = false;
      try {
        return await this.attempt(req, provider, pick.provider, i, pick, call);
      } catch (err) {
        lastError = err;
        if (!isAiError(err)) throw err;
        if (!err.retryable) throw err;
      }
    }

    // If every provider in the chain was breaker-open, surface a
    // user-visible error rather than silently throwing nothing.
    if (allSkippedByBreaker) {
      throw new AiError({
        kind: 'overload',
        provider: 'noop',
        message: `All providers for task "${req.task}" are circuit-broken. Recovery in progress.`,
      });
    }

    if (lastError) throw lastError;
    throw new AiError({
      kind: 'auth',
      provider: 'noop',
      message: `No providers available for task "${req.task}".`,
    });
  }

  private async attempt<
    R extends {
      provider: ProviderName;
      model: string;
      api_key_label: string;
      tokens_in: number;
      tokens_out: number;
      cost_micros: bigint;
      latency_ms: number;
    },
  >(
    req: { task: string; tenant_id?: string | null },
    provider: AiProvider,
    /** Routing slot identity. Use this (not provider.name) for breaker
     *  keying so test stand-ins like NoopProvider don't share state
     *  across slots. In production they're identical. */
    slot: ProviderName,
    attempt_index: number,
    pick: RoutePick,
    call: (provider: AiProvider, pick: RoutePick) => Promise<R>,
  ): Promise<R> {
    try {
      const res = await call(provider, pick);
      this.breaker.recordSuccess(slot);
      this.fireHook({
        task: req.task,
        tenant_id: req.tenant_id,
        attempt_index,
        provider: res.provider,
        model: res.model,
        api_key_label: res.api_key_label,
        outcome: 'success',
        tokens_in: res.tokens_in,
        tokens_out: res.tokens_out,
        cost_micros: res.cost_micros,
        latency_ms: res.latency_ms,
      });
      return res;
    } catch (err) {
      if (isAiError(err)) {
        this.breaker.recordFailure(slot, err.kind);
        this.fireHook({
          task: req.task,
          tenant_id: req.tenant_id,
          attempt_index,
          provider: slot,
          model: '<unknown>',
          outcome: 'error',
          error_kind: err.kind,
          latency_ms: 0,
        });
      }
      throw err;
    }
  }

  /**
   * Build the ordered list of picks (provider + optional model) to try,
   * deduped by provider.
   *   1. Primary (or secondary if weighted-random selects it) — keeps
   *      its `model` from the route config.
   *   2. Each entry in fallback_chain — provider name only; adapter
   *      defaults pick the model.
   */
  private buildAttemptOrder(route: RouteConfig): RoutePick[] {
    const first = pickPrimaryPick(route);
    const order: RoutePick[] = [first];
    for (const provider of route.fallback_chain) {
      if (!order.some((p) => p.provider === provider)) order.push({ provider });
    }
    return order;
  }

  private fireHook(event: Parameters<NonNullable<RouterHooks['onAttempt']>>[0]): void {
    const fn = this.hooks?.onAttempt;
    if (!fn) return;
    try {
      const maybe = fn(event);
      if (maybe instanceof Promise) {
        maybe.catch(() => {
          // Swallow — telemetry must never fail the user's call.
        });
      }
    } catch {
      // Swallow — same reason.
    }
  }
}

function pickPrimaryPick(route: RouteConfig): RoutePick {
  if (!route.secondary) return route.primary;
  const w = clamp01(route.secondary.weight);
  if (Math.random() < w) {
    const { weight: _w, ...pick } = route.secondary;
    return pick;
  }
  return route.primary;
}

/**
 * Merge a per-route `pick.model` into a request as `model_override` —
 * but only when the caller hasn't set their own. Caller-set
 * `model_override` always wins, preserving the manual escape hatch.
 */
function applyRouteModel<T extends { model_override?: string }>(req: T, pick: RoutePick): T {
  if (req.model_override || !pick.model) return req;
  return { ...req, model_override: pick.model };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ----------------------------------------------------------------------
// Singleton + factory
// ----------------------------------------------------------------------

export function createGateway(opts?: GatewayOptions): Gateway {
  return new Gateway(opts);
}

let _default: Gateway | null = null;

/**
 * Lazy singleton. Avoids instantiating providers (which read env vars)
 * at module load — important for tests + cold-start tracing. Wires the
 * AG-5 telemetry hook so every attempt logs to `ai_calls`.
 *
 * Static-imports `createTelemetryHook` (ESM-safe). Tests that build
 * their own Gateway via createGateway() with explicit providers don't
 * touch this path, so the admin client never gets imported in test
 * runtimes.
 */
export function gateway(): Gateway {
  if (!_default) {
    _default = createGateway({ hooks: createTelemetryHook() });
  }
  return _default;
}

/** Test-only: reset the singleton so a fresh env can be picked up. */
export function resetGatewayForTests(): void {
  _default = null;
}
