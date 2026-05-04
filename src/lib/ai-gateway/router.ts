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

import { AiError, isAiError, type ProviderName } from './errors';
import { AnthropicProvider } from './providers/anthropic';
import { GeminiProvider } from './providers/gemini';
import { NoopProvider } from './providers/noop';
import { OpenAiProvider } from './providers/openai';
import type { RouteConfig, RouterHooks } from './router-types';
import { lookupRoute } from './routing';
import type {
  AiProvider,
  ChatRequest,
  ChatResponse,
  StructuredRequest,
  StructuredResponse,
  VisionRequest,
  VisionResponse,
} from './types';

export type GatewayOptions = {
  providers?: Partial<Record<ProviderName, AiProvider>>;
  /** Override / extend per-task routing. Key wins over the default. */
  routing?: Record<string, RouteConfig>;
  hooks?: RouterHooks;
};

export class Gateway {
  private providers: Record<ProviderName, AiProvider | undefined>;
  private routing: Record<string, RouteConfig> | undefined;
  private hooks: RouterHooks | undefined;

  constructor(opts: GatewayOptions = {}) {
    this.providers = {
      openai: opts.providers?.openai ?? new OpenAiProvider(),
      gemini: opts.providers?.gemini ?? new GeminiProvider(),
      anthropic: opts.providers?.anthropic ?? new AnthropicProvider(),
      noop: opts.providers?.noop ?? new NoopProvider(),
    };
    this.routing = opts.routing;
    this.hooks = opts.hooks;
  }

  async runChat(req: ChatRequest): Promise<ChatResponse> {
    return this.run(req, (p) => p.callChat(req));
  }

  async runVision(req: VisionRequest): Promise<VisionResponse> {
    return this.run(req, (p) => p.callVision(req));
  }

  async runStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    return this.run(req, (p) => p.callStructured<T>(req));
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
    call: (provider: AiProvider) => Promise<R>,
  ): Promise<R> {
    // Hard override path: single attempt, no fallback.
    if (req.provider_override) {
      const provider = this.providers[req.provider_override];
      if (!provider) {
        throw new AiError({
          kind: 'auth',
          provider: req.provider_override,
          message: `Provider "${req.provider_override}" not configured.`,
        });
      }
      return this.attempt(req, provider, 0, call);
    }

    const route = lookupRoute(req.task, this.routing);
    const order = this.buildAttemptOrder(route);

    let lastError: unknown;
    for (let i = 0; i < order.length; i++) {
      const provider = this.providers[order[i]];
      if (!provider) continue;
      try {
        return await this.attempt(req, provider, i, call);
      } catch (err) {
        lastError = err;
        if (!isAiError(err)) throw err;
        if (!err.retryable) throw err;
      }
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
    attempt_index: number,
    call: (provider: AiProvider) => Promise<R>,
  ): Promise<R> {
    try {
      const res = await call(provider);
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
        this.fireHook({
          task: req.task,
          tenant_id: req.tenant_id,
          attempt_index,
          provider: provider.name,
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
   * Build the ordered list of providers to try, deduped.
   *   1. Primary (or secondary if weighted-random selects it)
   *   2. fallback_chain (skipping the already-chosen one)
   */
  private buildAttemptOrder(route: RouteConfig): ProviderName[] {
    const first = pickPrimary(route);
    const order: ProviderName[] = [first];
    for (const p of route.fallback_chain) {
      if (!order.includes(p)) order.push(p);
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

function pickPrimary(route: RouteConfig): ProviderName {
  if (!route.secondary) return route.primary.provider;
  const w = clamp01(route.secondary.weight);
  if (Math.random() < w) return route.secondary.provider;
  return route.primary.provider;
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
 * at module load — important for tests + cold-start tracing.
 */
export function gateway(): Gateway {
  if (!_default) _default = createGateway();
  return _default;
}

/** Test-only: reset the singleton so a fresh env can be picked up. */
export function resetGatewayForTests(): void {
  _default = null;
}
