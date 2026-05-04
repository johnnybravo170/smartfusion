/**
 * OpenAI adapter — error classification + happy-path shape via mocked fetch.
 *
 * No real API calls; the adapter's job here is to produce the right
 * AiResponse shape from a stub OpenAI response and the right AiError
 * kind from an HTTP error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAiError } from '@/lib/ai-gateway/errors';
import { resetCountersForTests } from '@/lib/ai-gateway/providers/keys';
import { OpenAiProvider } from '@/lib/ai-gateway/providers/openai';

const KEYS = [{ secret: 'sk-test', label: 'test' }];

function makeFetchMock(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

beforeEach(() => {
  resetCountersForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAiProvider — chat happy path', () => {
  it('returns a typed ChatResponse with cost + token usage', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(200, {
        model: 'gpt-4o-mini-2024-07-18',
        choices: [{ message: { content: 'hello back' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const provider = new OpenAiProvider({ keys: KEYS });
    const res = await provider.callChat({
      kind: 'chat',
      task: 'receipt_ocr',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.provider).toBe('openai');
    expect(res.text).toBe('hello back');
    expect(res.tokens_in).toBe(10);
    expect(res.tokens_out).toBe(5);
    // gpt-4o-mini: input 15 micros/tok, output 60 micros/tok
    // = 10*15 + 5*60 = 150 + 300 = 450 micros
    expect(res.cost_micros).toBe(BigInt(450));
    expect(res.api_key_label).toBe('test');
  });
});

describe('OpenAiProvider — error classification', () => {
  it('429 with insufficient_quota → AiError kind=quota', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(429, '{"error":{"message":"insufficient_quota","type":"insufficient_quota"}}'),
    );
    const provider = new OpenAiProvider({ keys: KEYS });
    try {
      await provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      });
      expect.fail('should have thrown');
    } catch (err) {
      if (!isAiError(err)) throw err;
      expect(err.kind).toBe('quota');
      expect(err.retryable).toBe(true);
      expect(err.status).toBe(429);
    }
  });

  it('429 generic rate limit → AiError kind=rate_limit', async () => {
    vi.stubGlobal('fetch', makeFetchMock(429, '{"error":{"message":"Rate limit exceeded"}}'));
    const provider = new OpenAiProvider({ keys: KEYS });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('503 → AiError kind=overload', async () => {
    vi.stubGlobal('fetch', makeFetchMock(503, '{"error":{"message":"upstream"}}'));
    const provider = new OpenAiProvider({ keys: KEYS });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'overload' });
  });

  it('401 → AiError kind=auth (not retryable)', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, '{"error":{"message":"bad key"}}'));
    const provider = new OpenAiProvider({ keys: KEYS });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'auth', retryable: false });
  });

  it('400 → AiError kind=invalid_input (not retryable)', async () => {
    vi.stubGlobal('fetch', makeFetchMock(400, '{"error":{"message":"bad request"}}'));
    const provider = new OpenAiProvider({ keys: KEYS });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input', retryable: false });
  });

  it('no key configured → AiError kind=auth', async () => {
    const provider = new OpenAiProvider({ keys: [] });
    await expect(
      provider.callChat({
        kind: 'chat',
        task: 'receipt_ocr',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('OpenAiProvider — structured', () => {
  it('parses JSON response and applies parse()', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: '{"amount_cents":1234}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      }),
    );
    const provider = new OpenAiProvider({ keys: KEYS });
    const res = await provider.callStructured<{ amount_cents: number }>({
      kind: 'structured',
      task: 'receipt_ocr',
      prompt: 'extract',
      schema: { type: 'object' },
      parse: (raw) => raw as { amount_cents: number },
    });
    expect(res.data.amount_cents).toBe(1234);
    expect(res.raw_text).toBe('{"amount_cents":1234}');
  });

  it('rejects non-JSON response with invalid_input', async () => {
    vi.stubGlobal(
      'fetch',
      makeFetchMock(200, {
        model: 'gpt-4o-mini',
        choices: [{ message: { content: 'not json' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const provider = new OpenAiProvider({ keys: KEYS });
    await expect(
      provider.callStructured({
        kind: 'structured',
        task: 'receipt_ocr',
        prompt: 'x',
        schema: { type: 'object' },
      }),
    ).rejects.toMatchObject({ kind: 'invalid_input' });
  });
});
