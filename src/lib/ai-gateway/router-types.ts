/**
 * Router-internal types. Kept separate from `types.ts` so the public
 * `AiProvider` surface doesn't leak routing concerns.
 */

import type { AiErrorKind, ProviderName } from './errors';

export type RoutePick = {
  provider: ProviderName;
  /** Model id override for this lane. Adapter default if omitted. */
  model?: string;
};

export type RouteConfig = {
  /** First-choice provider when no override is given. */
  primary: RoutePick;
  /** Optional weighted secondary, e.g. for tier-climbing. `weight` is the
   *  probability of picking secondary instead of primary, in [0, 1]. */
  secondary?: RoutePick & { weight: number };
  /** Ordered providers tried after a retryable error on the chosen lane.
   *  Already-tried providers are skipped. */
  fallback_chain: ProviderName[];
};

/**
 * Fired once per attempt — successful or failed. `createTelemetryHook`
 * wires this to the `ai_calls` insert so we can audit cost / failure
 * rate per task.
 */
export type RouterAttemptEvent = {
  task: string;
  /** 0 = primary lane, 1+ = each subsequent fallback. */
  attempt_index: number;
  provider: ProviderName;
  model: string;
  api_key_label?: string;
  tenant_id?: string | null;
  outcome: 'success' | 'error';
  error_kind?: AiErrorKind;
  tokens_in?: number;
  tokens_out?: number;
  cost_micros?: bigint;
  latency_ms: number;
};

export type RouterHooks = {
  /** Fired per attempt. Errors thrown here are swallowed — never fail
   *  the user's call because telemetry hiccupped. */
  onAttempt?: (event: RouterAttemptEvent) => void | Promise<void>;
};
