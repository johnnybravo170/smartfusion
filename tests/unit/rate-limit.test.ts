/**
 * Unit tests for the rate limiter helper.
 *
 * Mocks createAdminClient with an in-memory ledger so we can test the
 * sliding-window logic deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let now = 0;
let ledger: Array<{ bucket: string; attempted_at: number }> = [];
let nextSelectError: { code?: string; message: string } | null = null;

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => {
        let _bucket = '';
        let _sinceMs = 0;
        const builder = {
          eq(_col: string, val: string) {
            _bucket = val;
            return builder;
          },
          gte(_col: string, sinceIso: string) {
            _sinceMs = new Date(sinceIso).getTime();
            return builder;
          },
          order(_col: string, _opts: unknown) {
            return builder;
          },
          limit(_n: number) {
            if (nextSelectError) {
              return Promise.resolve({ data: null, error: nextSelectError });
            }
            const rows = ledger
              .filter((r) => r.bucket === _bucket && r.attempted_at >= _sinceMs)
              .sort((a, b) => a.attempted_at - b.attempted_at)
              .slice(0, _n)
              .map((r) => ({ attempted_at: new Date(r.attempted_at).toISOString() }));
            return Promise.resolve({ data: rows, error: null });
          },
        };
        return builder;
      },
      insert: (row: { bucket: string }) => {
        ledger.push({ bucket: row.bucket, attempted_at: now });
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

import { checkRateLimit, describeRetryAfter } from '@/lib/rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    now = 1_700_000_000_000;
    ledger = [];
    nextSelectError = null;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows attempts under the limit and increments remaining', async () => {
    const r1 = await checkRateLimit('signup:ip:1.1.1.1', { limit: 3, windowMs: 60_000 });
    expect(r1).toEqual({ ok: true, remaining: 2, retryAfterMs: 0 });
    const r2 = await checkRateLimit('signup:ip:1.1.1.1', { limit: 3, windowMs: 60_000 });
    expect(r2).toEqual({ ok: true, remaining: 1, retryAfterMs: 0 });
    const r3 = await checkRateLimit('signup:ip:1.1.1.1', { limit: 3, windowMs: 60_000 });
    expect(r3).toEqual({ ok: true, remaining: 0, retryAfterMs: 0 });
  });

  it('denies once the limit is reached, with non-zero retryAfterMs', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('signup:ip:2.2.2.2', { limit: 3, windowMs: 60_000 });
    }
    const denied = await checkRateLimit('signup:ip:2.2.2.2', { limit: 3, windowMs: 60_000 });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  it('does not log denied attempts (count stays at the limit)', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('phone:resend:+15551234', { limit: 3, windowMs: 60_000 });
    }
    const before = ledger.length;
    const denied = await checkRateLimit('phone:resend:+15551234', { limit: 3, windowMs: 60_000 });
    expect(denied.ok).toBe(false);
    expect(ledger.length).toBe(before); // no new row
  });

  it('rolls over after the window expires', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('signup:ip:3.3.3.3', { limit: 3, windowMs: 60_000 });
    }
    const denied = await checkRateLimit('signup:ip:3.3.3.3', { limit: 3, windowMs: 60_000 });
    expect(denied.ok).toBe(false);

    // Jump past the window.
    now += 61_000;
    const allowed = await checkRateLimit('signup:ip:3.3.3.3', { limit: 3, windowMs: 60_000 });
    expect(allowed.ok).toBe(true);
  });

  it('isolates buckets', async () => {
    for (let i = 0; i < 3; i++) {
      await checkRateLimit('a', { limit: 3, windowMs: 60_000 });
    }
    const aDenied = await checkRateLimit('a', { limit: 3, windowMs: 60_000 });
    const bAllowed = await checkRateLimit('b', { limit: 3, windowMs: 60_000 });
    expect(aDenied.ok).toBe(false);
    expect(bAllowed.ok).toBe(true);
  });

  it('falls open on DB errors', async () => {
    nextSelectError = { code: '42P01', message: 'relation not found' };
    const r = await checkRateLimit('any', { limit: 1, windowMs: 1000 });
    expect(r.ok).toBe(true);
  });
});

describe('describeRetryAfter', () => {
  it('formats seconds, minutes, hours', () => {
    expect(describeRetryAfter(5_000)).toBe('5s');
    expect(describeRetryAfter(2 * 60_000)).toBe('2 minutes');
    expect(describeRetryAfter(60 * 60_000 + 1)).toBe('2 hours');
  });
});
