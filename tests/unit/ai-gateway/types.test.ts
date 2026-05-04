/**
 * AG-1 — coverage of the contract. We don't have providers wired yet,
 * so this file proves:
 *   - The interface compiles for a real implementor (NoopProvider)
 *   - Errors classify and retry-default correctly
 *   - Echo mode round-trips chat / vision / structured shapes
 *   - Fail mode throws AiError with the configured kind
 */

import { describe, expect, it } from 'vitest';
import {
  AiError,
  type AiErrorKind,
  type AiProvider,
  defaultRetryable,
  isAiError,
  KNOWN_TASKS,
  NoopProvider,
} from '@/lib/ai-gateway';

describe('KNOWN_TASKS', () => {
  it('contains the receipt OCR task we hot-fixed earlier', () => {
    expect(KNOWN_TASKS).toContain('receipt_ocr');
  });
  it('exposes a stable list (typo-protection)', () => {
    expect(KNOWN_TASKS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('AiError', () => {
  it('defaults retryable per error kind', () => {
    const cases: Array<[AiErrorKind, boolean]> = [
      ['quota', true],
      ['overload', true],
      ['rate_limit', true],
      ['timeout', true],
      ['unknown', true],
      ['invalid_input', false],
      ['auth', false],
    ];
    for (const [kind, expected] of cases) {
      expect(defaultRetryable(kind)).toBe(expected);
      const err = new AiError({ kind, provider: 'noop', message: 'x' });
      expect(err.retryable).toBe(expected);
    }
  });

  it('respects an explicit retryable override', () => {
    const err = new AiError({ kind: 'auth', provider: 'noop', message: 'x', retryable: true });
    expect(err.retryable).toBe(true);
  });

  it('preserves status and cause for telemetry', () => {
    const cause = new Error('underlying');
    const err = new AiError({
      kind: 'quota',
      provider: 'openai',
      message: 'insufficient_quota',
      status: 429,
      cause,
    });
    expect(err.status).toBe(429);
    expect(err.cause).toBe(cause);
  });

  it('isAiError type guards across module boundary', () => {
    expect(isAiError(new AiError({ kind: 'unknown', provider: 'noop', message: 'x' }))).toBe(true);
    expect(isAiError(new Error('plain'))).toBe(false);
    expect(isAiError({ kind: 'quota' })).toBe(false);
    expect(isAiError(null)).toBe(false);
  });
});

describe('NoopProvider — echo mode', () => {
  const provider: AiProvider = new NoopProvider();

  it('round-trips a chat call', async () => {
    const res = await provider.callChat({
      kind: 'chat',
      task: 'receipt_ocr',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.provider).toBe('noop');
    expect(res.text).toBe('hello');
    expect(res.cost_micros).toBe(BigInt(0));
    expect(res.tokens_in).toBeGreaterThan(0);
  });

  it('round-trips a vision call with a file mime', async () => {
    const res = await provider.callVision({
      kind: 'vision',
      task: 'receipt_ocr',
      prompt: 'Extract amount',
      file: { mime: 'image/jpeg', base64: 'AAAA' },
    });
    expect(res.text).toContain('image/jpeg');
  });

  it('round-trips a structured call with parse', async () => {
    const stub = new NoopProvider({ kind: 'echo', canned_data: { amount_cents: 1234 } });
    const res = await stub.callStructured<{ amount_cents: number }>({
      kind: 'structured',
      task: 'receipt_ocr',
      prompt: 'Extract',
      schema: { type: 'object' },
      parse: (raw) => raw as { amount_cents: number },
    });
    expect(res.data.amount_cents).toBe(1234);
    expect(res.raw_text).toBe('{"amount_cents":1234}');
  });
});

describe('NoopProvider — transcribe', () => {
  it('round-trips an audio transcribe call', async () => {
    const provider = new NoopProvider({ kind: 'echo', canned_text: 'hello world transcript' });
    const res = await provider.callTranscribe({
      kind: 'transcribe',
      task: 'audio_transcribe_intake',
      file: { mime: 'audio/webm', base64: 'AAAA' },
      prompt: 'contractor scoping',
    });
    expect(res.kind).toBe('transcribe');
    expect(res.text).toBe('hello world transcript');
    expect(res.provider).toBe('noop');
  });
});

describe('NoopProvider — fail mode', () => {
  it('throws AiError with the configured kind', async () => {
    const provider = new NoopProvider({ kind: 'fail', error_kind: 'quota' });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it('thrown error carries provider + kind for routing decisions', async () => {
    const provider = new NoopProvider({ kind: 'fail', error_kind: 'overload' });
    try {
      await provider.callVision({
        kind: 'vision',
        task: 'receipt_ocr',
        prompt: 'x',
        file: { mime: 'image/jpeg', base64: 'AAAA' },
      });
      expect.fail('should have thrown');
    } catch (err) {
      if (!isAiError(err)) throw err;
      expect(err.kind).toBe('overload');
      expect(err.provider).toBe('noop');
      expect(err.retryable).toBe(true);
    }
  });

  it('mode swap mid-test for sequential router scenarios', async () => {
    const provider = new NoopProvider();
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'first' }],
      }),
    ).resolves.toMatchObject({ text: 'first' });

    provider.setMode({ kind: 'fail', error_kind: 'auth' });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'second' }],
      }),
    ).rejects.toMatchObject({ kind: 'auth', retryable: false });
  });
});
