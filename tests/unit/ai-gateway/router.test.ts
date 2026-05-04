/**
 * AG-3 router — selection, fallback, override, hook telemetry.
 *
 * All tests use NoopProvider in echo or fail mode so behavior is
 * deterministic. Real adapter tests live in their own files.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiError,
  type AiErrorKind,
  type AiProvider,
  createGateway,
  NoopProvider,
  type RouteConfig,
  type RouterAttemptEvent,
} from '@/lib/ai-gateway';

function buildGateway(opts: {
  providers?: Partial<Record<'openai' | 'gemini' | 'anthropic' | 'noop', AiProvider>>;
  routing?: Record<string, RouteConfig>;
  hooks?: { onAttempt: (e: RouterAttemptEvent) => void };
}) {
  return createGateway(opts);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('routing — primary selection', () => {
  it('routes to primary when no secondary is configured', async () => {
    const events: RouterAttemptEvent[] = [];
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'gemini-output' }),
        openai: new NoopProvider({ kind: 'echo', canned_text: 'openai-output' }),
      },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('gemini-output');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'success', attempt_index: 0 });
  });

  it('weighted secondary fires per Math.random()', async () => {
    // Force secondary by stubbing random < weight.
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'gemini' }),
        openai: new NoopProvider({ kind: 'echo', canned_text: 'openai' }),
      },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          secondary: { provider: 'openai', weight: 0.5 },
          fallback_chain: ['gemini', 'openai'],
        },
      },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('openai');
  });

  it('weighted primary fires when random ≥ weight', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'gemini' }),
        openai: new NoopProvider({ kind: 'echo', canned_text: 'openai' }),
      },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          secondary: { provider: 'openai', weight: 0.5 },
          fallback_chain: ['gemini', 'openai'],
        },
      },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('gemini');
  });
});

describe('routing — fallback walk', () => {
  it('falls through on retryable error and emits two events', async () => {
    const events: RouterAttemptEvent[] = [];
    const failQuota = new NoopProvider({ kind: 'fail', error_kind: 'quota' });
    const ok = new NoopProvider({ kind: 'echo', canned_text: 'recovered' });
    const gw = buildGateway({
      providers: { gemini: failQuota, openai: ok },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });

    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('recovered');
    expect(events).toHaveLength(2);
    // NoopProvider always self-reports as 'noop'; in production each
    // adapter reports its own real name. We're verifying the SHAPE of
    // the events, not the slot identity.
    expect(events[0]).toMatchObject({
      attempt_index: 0,
      outcome: 'error',
      error_kind: 'quota',
    });
    expect(events[1]).toMatchObject({
      attempt_index: 1,
      outcome: 'success',
    });
  });

  it('throws immediately on non-retryable (auth) — no fallback', async () => {
    const events: RouterAttemptEvent[] = [];
    const failAuth = new NoopProvider({ kind: 'fail', error_kind: 'auth' });
    const ok = new NoopProvider({ kind: 'echo', canned_text: 'should-not-reach' });
    const gw = buildGateway({
      providers: { gemini: failAuth, openai: ok },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });

    await expect(
      gw.runChat({
        kind: 'chat',
        task: 'my_task',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
    expect(events).toHaveLength(1);
  });

  it('exhausts the chain and rethrows last error when all fail', async () => {
    const failQuota = new NoopProvider({ kind: 'fail', error_kind: 'quota' });
    const failOverload = new NoopProvider({ kind: 'fail', error_kind: 'overload' });
    const gw = buildGateway({
      providers: { gemini: failQuota, openai: failOverload },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
    });

    let caught: unknown;
    try {
      await gw.runChat({
        kind: 'chat',
        task: 'my_task',
        messages: [{ role: 'user', content: 'x' }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AiError);
    expect((caught as AiError).kind).toBe('overload'); // last attempted
  });

  it('dedupes — provider in fallback_chain that matches primary is skipped', async () => {
    const events: RouterAttemptEvent[] = [];
    const failQuota = new NoopProvider({ kind: 'fail', error_kind: 'quota' });
    const ok = new NoopProvider({ kind: 'echo', canned_text: 'ok' });
    const gw = buildGateway({
      providers: { gemini: failQuota, openai: ok },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          // gemini listed first in chain — should be skipped, not retried
          fallback_chain: ['gemini', 'openai'],
        },
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });
    await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    // Dedup proof: TWO attempts (not three). Slot order was [gemini,
    // openai] after deduping the duplicate gemini in the chain.
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.outcome)).toEqual(['error', 'success']);
  });
});

describe('routing — provider_override', () => {
  it('bypasses routing entirely when set', async () => {
    const events: RouterAttemptEvent[] = [];
    const overridden = new NoopProvider({ kind: 'echo', canned_text: 'forced' });
    const wouldBePrimary = new NoopProvider({ kind: 'echo', canned_text: 'never' });
    const gw = buildGateway({
      providers: { openai: overridden, gemini: wouldBePrimary },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      provider_override: 'openai',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('forced');
    expect(events).toHaveLength(1); // single attempt, no fallback
  });

  it('overridden provider failure does NOT fall through', async () => {
    const overridden = new NoopProvider({ kind: 'fail', error_kind: 'quota' });
    const otherwise = new NoopProvider({ kind: 'echo', canned_text: 'should-not-reach' });
    const gw = buildGateway({
      providers: { openai: overridden, gemini: otherwise },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini', 'openai'],
        },
      },
    });
    await expect(
      gw.runChat({
        kind: 'chat',
        task: 'my_task',
        provider_override: 'openai',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'quota' });
  });
});

describe('routing — unknown task fallback', () => {
  it("uses DEFAULT_ROUTE when task isn't in config", async () => {
    const events: RouterAttemptEvent[] = [];
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'default-routed' }),
      },
      hooks: { onAttempt: (e) => events.push(e) },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'totally_made_up_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('default-routed');
    expect(events[0]?.task).toBe('totally_made_up_task');
  });
});

describe('hooks — failure isolation', () => {
  it('hook errors do NOT fail the user call', async () => {
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'still-works' }),
      },
      routing: {
        my_task: {
          primary: { provider: 'gemini' },
          fallback_chain: ['gemini'],
        },
      },
      hooks: {
        onAttempt: () => {
          throw new Error('telemetry exploded');
        },
      },
    });
    const res = await gw.runChat({
      kind: 'chat',
      task: 'my_task',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(res.text).toBe('still-works');
  });
});

describe('runVision + runStructured', () => {
  it('runVision dispatches to provider.callVision', async () => {
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_text: 'visioned' }),
      },
      routing: {
        my_task: { primary: { provider: 'gemini' }, fallback_chain: ['gemini'] },
      },
    });
    const res = await gw.runVision({
      kind: 'vision',
      task: 'my_task',
      prompt: 'extract',
      file: { mime: 'image/jpeg', base64: 'AAAA' },
    });
    expect(res.kind).toBe('vision');
    expect(res.text).toBe('visioned');
  });

  it('runStructured dispatches to provider.callStructured + parse', async () => {
    const gw = buildGateway({
      providers: {
        gemini: new NoopProvider({ kind: 'echo', canned_data: { n: 7 } }),
      },
      routing: {
        my_task: { primary: { provider: 'gemini' }, fallback_chain: ['gemini'] },
      },
    });
    const res = await gw.runStructured<{ n: number }>({
      kind: 'structured',
      task: 'my_task',
      prompt: 'x',
      schema: { type: 'object' },
      parse: (raw) => raw as { n: number },
    });
    expect(res.data.n).toBe(7);
  });
});
