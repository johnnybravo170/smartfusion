/**
 * AG-4 — circuit breaker semantics.
 *
 * All tests use a fake clock so we can advance time in milliseconds
 * without sleeping.
 */

import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '@/lib/ai-gateway/circuit-breaker';

function fakeClock(start = 1000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (t: number) => {
      now = t;
    },
  };
}

describe('CircuitBreaker — closed by default', () => {
  it('does not skip a never-failed provider', () => {
    const cb = new CircuitBreaker();
    expect(cb.shouldSkip('openai')).toBe(false);
    expect(cb.shouldSkip('gemini')).toBe(false);
  });

  it('keeps closed on auth / invalid_input failures (caller bug, not provider health)', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure('openai', 'auth');
    cb.recordFailure('openai', 'invalid_input');
    expect(cb.shouldSkip('openai')).toBe(false);
  });
});

describe('CircuitBreaker — quota trips immediately, 30 min', () => {
  it('opens after a single quota failure for 30 min', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'quota');
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(29 * 60 * 1000);
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(2 * 60 * 1000); // total 31 min
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('isolates state per provider', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure('openai', 'quota');
    expect(cb.shouldSkip('openai')).toBe(true);
    expect(cb.shouldSkip('gemini')).toBe(false);
  });
});

describe('CircuitBreaker — overload burst threshold', () => {
  it('does NOT trip on 1 or 2 overloads', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure('openai', 'overload');
    cb.recordFailure('openai', 'overload');
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('trips on the 3rd overload within 60s for 5 min', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'overload');
    c.advance(10_000);
    cb.recordFailure('openai', 'overload');
    c.advance(10_000);
    cb.recordFailure('openai', 'overload');
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(4 * 60 * 1000);
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(2 * 60 * 1000); // total 6 min after trip
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('does NOT trip when overloads are spread > 60s apart', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'overload');
    c.advance(70_000); // first one slides out of the window
    cb.recordFailure('openai', 'overload');
    c.advance(70_000); // second slides out
    cb.recordFailure('openai', 'overload');
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('rate_limit and timeout count toward the same burst', () => {
    const cb = new CircuitBreaker();
    cb.recordFailure('openai', 'overload');
    cb.recordFailure('openai', 'rate_limit');
    cb.recordFailure('openai', 'timeout');
    expect(cb.shouldSkip('openai')).toBe(true);
  });
});

describe('CircuitBreaker — half-open recovery', () => {
  it('successful trial after open_until elapses fully closes', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'quota');
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(31 * 60 * 1000); // past quota window
    expect(cb.shouldSkip('openai')).toBe(false);
    cb.recordSuccess('openai');
    expect(cb.inspect('openai')).toBeUndefined();
  });

  it('failed trial doubles the window (capped 60 min)', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    // Trip with quota → 30 min window
    cb.recordFailure('openai', 'quota');
    c.advance(31 * 60 * 1000); // past window — half-open
    expect(cb.shouldSkip('openai')).toBe(false);
    // Trial fails with overload → re-open at 60 min (2× 30, capped at 60).
    cb.recordFailure('openai', 'overload');
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(59 * 60 * 1000);
    expect(cb.shouldSkip('openai')).toBe(true);
    c.advance(2 * 60 * 1000); // total 61 min after trial fail
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('doubled window is capped at 60 min even after multiple failed trials', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'quota'); // open 30 min
    c.advance(31 * 60 * 1000);
    cb.recordFailure('openai', 'overload'); // open 60 min (doubled)
    c.advance(61 * 60 * 1000);
    cb.recordFailure('openai', 'overload'); // would be 120 min but capped at 60
    const state = cb.inspect('openai');
    expect(state?.last_window_ms).toBe(60 * 60 * 1000);
  });

  it('successful trial after overload window also closes', () => {
    const c = fakeClock();
    const cb = new CircuitBreaker(c.now);
    cb.recordFailure('openai', 'overload');
    cb.recordFailure('openai', 'overload');
    cb.recordFailure('openai', 'overload');
    c.advance(6 * 60 * 1000);
    cb.recordSuccess('openai');
    expect(cb.inspect('openai')).toBeUndefined();
    expect(cb.shouldSkip('openai')).toBe(false);
  });
});

describe('CircuitBreaker — auth / invalid_input never trip', () => {
  it('100 auth failures do not open the breaker', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 100; i++) cb.recordFailure('openai', 'auth');
    expect(cb.shouldSkip('openai')).toBe(false);
  });

  it('100 invalid_input failures do not open either', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 100; i++) cb.recordFailure('openai', 'invalid_input');
    expect(cb.shouldSkip('openai')).toBe(false);
  });
});
