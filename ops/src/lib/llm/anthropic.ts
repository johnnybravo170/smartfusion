/**
 * Anthropic provider. Uses @anthropic-ai/sdk directly so we get prompt
 * caching for the Jonathan AI imprint (~4k tokens loaded on every chair
 * turn). Cache hits are billed at 10% of input.
 */

import Anthropic from '@anthropic-ai/sdk';
import { trackOpsAiCall } from './telemetry';
import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  tokensToCents,
} from './types';

// Public list rates (USD per million tokens). Verified 2026-05-04 from
// anthropic.com/pricing. Update when we change defaults; lookup falls back
// to Sonnet rates for unknown models so cost tracking never silently zeros.
const RATES: Record<string, { in: number; out: number }> = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 0.8, out: 4 },
  'claude-opus-4-7': { in: 15, out: 75 },
};
const FALLBACK_RATE = RATES['claude-sonnet-4-6'];

function lookupRate(model: string): { in: number; out: number } {
  if (RATES[model]) return RATES[model];
  // dated aliases like "claude-sonnet-4-6-20260101" prefix-match the family
  for (const key of Object.keys(RATES)) {
    if (model.startsWith(key)) return RATES[key];
  }
  return FALLBACK_RATE;
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private client: Anthropic;

  constructor(apiKey?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new LlmError('ANTHROPIC_API_KEY not set', 'anthropic');
    this.client = new Anthropic({ apiKey: key });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const t0 = Date.now();

    const system = buildSystemBlocks(req.system);

    let msg: Anthropic.Message;
    try {
      msg = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.max_tokens ?? 1024,
          temperature: req.temperature ?? 0.7,
          ...(system ? { system } : {}),
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { timeout: req.timeout_ms ?? 120_000 },
      );
    } catch (err) {
      const wrapped = wrapAnthropicError(err);
      trackOpsAiCall({
        task: req.task ?? 'ops:board',
        provider: 'anthropic',
        model: req.model,
        status: 'error',
        latency_ms: Date.now() - t0,
        error_message: wrapped.message,
      });
      throw wrapped;
    }

    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    const tokens_in =
      msg.usage.input_tokens +
      // Cache reads are billed but not counted in input_tokens; surface them
      // in the same "what we paid for" bucket so cost matches reality.
      (msg.usage.cache_read_input_tokens ?? 0);
    const tokens_out = msg.usage.output_tokens;

    const rate = lookupRate(req.model);
    const result: LlmResponse = {
      provider: 'anthropic',
      model: msg.model ?? req.model,
      text,
      prompt_tokens: tokens_in,
      completion_tokens: tokens_out,
      cost_cents: tokensToCents(tokens_in, tokens_out, rate.in, rate.out),
      latency_ms: Date.now() - t0,
    };
    trackOpsAiCall({
      task: req.task ?? 'ops:board',
      provider: 'anthropic',
      model: result.model,
      status: 'success',
      tokens_in: result.prompt_tokens,
      tokens_out: result.completion_tokens,
      cost_cents: result.cost_cents,
      latency_ms: result.latency_ms,
    });
    return result;
  }
}

function buildSystemBlocks(system: LlmRequest['system']): Anthropic.MessageCreateParams['system'] {
  if (system === undefined) return undefined;
  const arr = Array.isArray(system) ? system : [system];
  if (arr.length === 0) return undefined;
  // Plain strings, no caching: pass as a string for ergonomics.
  if (arr.every((b) => typeof b === 'string')) {
    return arr.join('\n\n');
  }
  return arr.map((b) => {
    if (typeof b === 'string') return { type: 'text', text: b } as const;
    return {
      type: 'text' as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: 'ephemeral' as const } } : {}),
    };
  });
}

function wrapAnthropicError(err: unknown): LlmError {
  if (err instanceof Anthropic.APIError) {
    const retryable = err.status === undefined || err.status >= 500 || err.status === 429;
    return new LlmError(
      `Anthropic API ${err.status ?? '?'}: ${err.message}`,
      'anthropic',
      err.status ?? undefined,
      retryable,
    );
  }
  if (err instanceof Error) return new LlmError(err.message, 'anthropic', undefined, true);
  return new LlmError('Unknown Anthropic error', 'anthropic');
}
