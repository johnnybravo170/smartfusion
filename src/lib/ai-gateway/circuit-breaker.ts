/**
 * AG-4 — circuit breaker. When a provider hits a quota cliff or
 * spits out a burst of 503s, take it out of rotation for a recovery
 * window so the router doesn't burn latency retrying it on every
 * subsequent call.
 *
 * State machine:
 *
 *   ┌────────┐  quota fail            ┌──────┐
 *   │ closed │ ─────────────────────▶ │ open │
 *   └────────┘                         └──────┘
 *       │                                 │  open_until elapses
 *       │                                 ▼
 *       │  trial success           ┌────────────┐
 *       └─────────────────────────│  half-open │
 *                                  └────────────┘
 *                                       │ trial fails
 *                                       ▼
 *                              re-open with 2× window
 *                              (capped at 60 minutes)
 *
 * Tripping rules per error kind:
 *   - quota          → trip immediately, 30 min window
 *   - overload       → trip when 3+ within 60s, 5 min window
 *   - rate_limit     → same as overload
 *   - timeout        → same as overload
 *   - auth, invalid_input → never trip (caller bug, not provider health)
 *
 * Half-open semantics: when `open_until` elapses, the breaker reports
 * `shouldSkip = false` again — the next request becomes a trial. We
 * intentionally DON'T gate the trial behind a single-flight lock. In a
 * multi-instance Vercel runtime each instance has its own breaker state
 * anyway; coordinating "only one trial across the fleet" would require
 * shared state we don't have. Worst case multiple concurrent trials
 * fail, the breaker re-opens with the same doubled window — same end
 * state as a single-flight implementation.
 *
 * Keying: per provider only, not per provider+model. Our gateway runs
 * one default model per provider; model-level granularity is overkill
 * for v1. Revisit if we ever route the same task to multiple models on
 * the same provider.
 */

import type { AiErrorKind, ProviderName } from './errors';

const QUOTA_WINDOW_MS = 30 * 60 * 1000; // 30 min
const OVERLOAD_WINDOW_MS = 5 * 60 * 1000; // 5 min
const MAX_WINDOW_MS = 60 * 60 * 1000; // 60 min cap on doubling
const OVERLOAD_BURST_THRESHOLD = 3; // 3 failures
const OVERLOAD_BURST_WINDOW_MS = 60 * 1000; // within 60s

type BreakerState = {
  /** ms timestamp; 0 = closed. */
  open_until: number;
  /** Window we used last time we opened — for doubling on failed trials. */
  last_window_ms: number;
  /** ms timestamps of recent overload-class failures; pruned to <60s. */
  recent_overload_failures: number[];
};

type Clock = () => number;

export class CircuitBreaker {
  private states = new Map<ProviderName, BreakerState>();
  private clock: Clock;

  constructor(clock?: Clock) {
    this.clock = clock ?? Date.now;
  }

  /** Should the router skip this provider on the current call? */
  shouldSkip(provider: ProviderName): boolean {
    const s = this.states.get(provider);
    if (!s) return false;
    return this.clock() < s.open_until;
  }

  /**
   * Successful call resets state. If we were in half-open (open_until
   * just elapsed and we let a trial through), this fully closes the
   * breaker — `last_window_ms` reset so a future trip starts at the
   * base window again.
   */
  recordSuccess(provider: ProviderName): void {
    const s = this.states.get(provider);
    if (!s) return;
    if (s.open_until > 0) {
      // Half-open trial succeeded — fully close.
      this.states.delete(provider);
    }
  }

  /**
   * Failed call. May or may not trip the breaker depending on `kind`
   * and recent failure history.
   */
  recordFailure(provider: ProviderName, kind: AiErrorKind): void {
    if (kind === 'auth' || kind === 'invalid_input') return;

    const now = this.clock();
    let s = this.states.get(provider);

    // Failed half-open trial: double the window.
    if (s && s.open_until > 0 && now >= s.open_until) {
      const next = Math.min(s.last_window_ms * 2, MAX_WINDOW_MS);
      s.open_until = now + next;
      s.last_window_ms = next;
      return;
    }

    if (kind === 'quota') {
      this.states.set(provider, {
        open_until: now + QUOTA_WINDOW_MS,
        last_window_ms: QUOTA_WINDOW_MS,
        recent_overload_failures: [],
      });
      return;
    }

    if (kind === 'overload' || kind === 'rate_limit' || kind === 'timeout' || kind === 'unknown') {
      if (!s) {
        s = { open_until: 0, last_window_ms: 0, recent_overload_failures: [] };
        this.states.set(provider, s);
      }
      // Add this failure + prune older than the burst window.
      s.recent_overload_failures.push(now);
      const cutoff = now - OVERLOAD_BURST_WINDOW_MS;
      s.recent_overload_failures = s.recent_overload_failures.filter((t) => t >= cutoff);

      if (s.recent_overload_failures.length >= OVERLOAD_BURST_THRESHOLD) {
        s.open_until = now + OVERLOAD_WINDOW_MS;
        s.last_window_ms = OVERLOAD_WINDOW_MS;
        s.recent_overload_failures = [];
      }
    }
  }

  /** Test-only: read state for assertions. */
  inspect(provider: ProviderName): Readonly<BreakerState> | undefined {
    return this.states.get(provider);
  }

  /**
   * Snapshot of every currently-open breaker. Used by AG-8's admin
   * dashboard to render the "circuit-broken right now" list.
   */
  openSnapshot(): Array<{
    provider: ProviderName;
    open_until_iso: string;
    last_window_ms: number;
  }> {
    const now = this.clock();
    const out: Array<{ provider: ProviderName; open_until_iso: string; last_window_ms: number }> =
      [];
    for (const [provider, s] of this.states.entries()) {
      if (s.open_until > now) {
        out.push({
          provider,
          open_until_iso: new Date(s.open_until).toISOString(),
          last_window_ms: s.last_window_ms,
        });
      }
    }
    return out;
  }

  /** Test-only: reset all state. */
  reset(): void {
    this.states.clear();
  }
}
