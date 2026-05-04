/**
 * Anthropic adapter using @anthropic-ai/sdk (already a repo dependency).
 *
 * Vision: PDFs and images supported via document content blocks.
 * Structured: Anthropic doesn't have a JSON-schema mode, so we ask for
 * JSON via system prompt + parse the response. Schema is documented to
 * the model in the prompt; we trust + validate via `parse`.
 *
 * Rates verified 2026-05-03 from anthropic.com/pricing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { AiError, type AiErrorKind } from '../errors';
import type {
  AiProvider,
  ChatRequest,
  ChatResponse,
  StructuredRequest,
  StructuredResponse,
  VisionRequest,
  VisionResponse,
} from '../types';
import { computeCostMicros, lookupRates, type ModelRates, usdPerMillionToMicros } from './cost';
import { type ApiKey, parseKeyEnv, pickKey } from './keys';

const RATES: Record<string, ModelRates> = {
  'claude-haiku-4-5': {
    input_micros_per_token: usdPerMillionToMicros(0.8),
    output_micros_per_token: usdPerMillionToMicros(4),
  },
  'claude-3-5-haiku': {
    input_micros_per_token: usdPerMillionToMicros(0.8),
    output_micros_per_token: usdPerMillionToMicros(4),
  },
  'claude-sonnet-4-5': {
    input_micros_per_token: usdPerMillionToMicros(3),
    output_micros_per_token: usdPerMillionToMicros(15),
  },
  'claude-3-7-sonnet': {
    input_micros_per_token: usdPerMillionToMicros(3),
    output_micros_per_token: usdPerMillionToMicros(15),
  },
  'claude-opus-4-1': {
    input_micros_per_token: usdPerMillionToMicros(15),
    output_micros_per_token: usdPerMillionToMicros(75),
  },
  '*': {
    input_micros_per_token: usdPerMillionToMicros(0.8),
    output_micros_per_token: usdPerMillionToMicros(4),
  },
};

const DEFAULT_MODELS = {
  chat: 'claude-haiku-4-5',
  vision: 'claude-haiku-4-5',
  structured: 'claude-haiku-4-5',
};

const DEFAULT_MAX_TOKENS = 4096;

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;
  private keys: ApiKey[];

  constructor(opts?: { keys?: ApiKey[] }) {
    this.keys =
      opts?.keys ?? parseKeyEnv(process.env.ANTHROPIC_API_KEYS, process.env.ANTHROPIC_API_KEY);
  }

  async callChat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.chat;
    const { msg, key, latency_ms } = await this.run((client) =>
      client.messages.create({
        model,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        system: req.system,
        messages: req.messages,
        temperature: req.temperature,
      }),
    );
    return {
      kind: 'chat',
      provider: 'anthropic',
      model: msg.model ?? model,
      api_key_label: key.label,
      tokens_in: msg.usage.input_tokens,
      tokens_out: msg.usage.output_tokens,
      cost_micros: computeCostMicros(
        msg.usage.input_tokens,
        msg.usage.output_tokens,
        lookupRates(RATES, msg.model ?? model),
      ),
      latency_ms,
      text: extractText(msg),
    };
  }

  async callVision(req: VisionRequest): Promise<VisionResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.vision;
    const fileBlocks = filesOf(req).map(toAnthropicFileBlock);
    const { msg, key, latency_ms } = await this.run((client) =>
      client.messages.create({
        model,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          {
            role: 'user',
            // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK content block typing isn't worth fighting here
            content: [...fileBlocks, { type: 'text', text: req.prompt }] as any,
          },
        ],
      }),
    );
    return {
      kind: 'vision',
      provider: 'anthropic',
      model: msg.model ?? model,
      api_key_label: key.label,
      tokens_in: msg.usage.input_tokens,
      tokens_out: msg.usage.output_tokens,
      cost_micros: computeCostMicros(
        msg.usage.input_tokens,
        msg.usage.output_tokens,
        lookupRates(RATES, msg.model ?? model),
      ),
      latency_ms,
      text: extractText(msg),
    };
  }

  async callStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const model = req.model_override ?? DEFAULT_MODELS.structured;
    const schemaPrompt = `${req.prompt}\n\nReturn ONLY JSON matching this schema, no prose, no markdown fences:\n${JSON.stringify(req.schema)}`;
    const fileBlocks = filesOf(req).map(toAnthropicFileBlock);
    const userContent: Array<Record<string, unknown>> = [
      ...fileBlocks,
      { type: 'text', text: schemaPrompt },
    ];
    const { msg, key, latency_ms } = await this.run((client) =>
      client.messages.create({
        model,
        max_tokens: req.max_tokens ?? DEFAULT_MAX_TOKENS,
        // biome-ignore lint/suspicious/noExplicitAny: Anthropic SDK content block typing isn't worth fighting here
        messages: [{ role: 'user', content: userContent as any }],
        temperature: req.temperature ?? 0.1,
      }),
    );
    const rawText = extractText(msg).trim();
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'anthropic',
        message: 'Anthropic returned non-JSON for a structured request.',
      });
    }
    let data: T;
    try {
      data = req.parse ? req.parse(parsed) : (parsed as T);
    } catch (cause) {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'anthropic',
        message: cause instanceof Error ? cause.message : 'parse() rejected response',
        cause,
      });
    }
    return {
      kind: 'structured',
      provider: 'anthropic',
      model: msg.model ?? model,
      api_key_label: key.label,
      tokens_in: msg.usage.input_tokens,
      tokens_out: msg.usage.output_tokens,
      cost_micros: computeCostMicros(
        msg.usage.input_tokens,
        msg.usage.output_tokens,
        lookupRates(RATES, msg.model ?? model),
      ),
      latency_ms,
      data,
      raw_text: rawText,
    };
  }

  private async run<T>(
    fn: (client: Anthropic) => Promise<T>,
  ): Promise<{ msg: T; key: ApiKey; latency_ms: number }> {
    const key = pickKey('anthropic', this.keys);
    if (!key) {
      throw new AiError({
        kind: 'auth',
        provider: 'anthropic',
        message: 'No Anthropic API key configured (ANTHROPIC_API_KEYS or ANTHROPIC_API_KEY).',
      });
    }
    const client = new Anthropic({ apiKey: key.secret });
    const start = Date.now();
    try {
      const msg = await fn(client);
      return { msg, key, latency_ms: Date.now() - start };
    } catch (cause) {
      throw classifyAnthropicError(cause);
    }
  }
}

function extractText(msg: { content: Array<{ type: string; text?: string }> }): string {
  return msg.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('');
}

function filesOf(req: {
  file?: { mime: string; base64: string };
  files?: Array<{ mime: string; base64: string }>;
}) {
  const out: Array<{ mime: string; base64: string }> = [];
  if (req.file) out.push(req.file);
  if (req.files) out.push(...req.files);
  return out;
}

function toAnthropicFileBlock(f: { mime: string; base64: string }): Record<string, unknown> {
  if (f.mime === 'application/pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: f.base64 },
    };
  }
  return {
    type: 'image',
    source: { type: 'base64', media_type: f.mime, data: f.base64 },
  };
}

function classifyAnthropicError(cause: unknown): AiError {
  const status =
    (cause as { status?: number; statusCode?: number })?.status ??
    (cause as { statusCode?: number })?.statusCode;
  const msg = cause instanceof Error ? cause.message : String(cause);
  const lower = msg.toLowerCase();
  let kind: AiErrorKind = 'unknown';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_input';
  else if (status === 429) kind = 'rate_limit';
  else if (status === 529) kind = 'overload';
  else if (status && status >= 500) kind = 'overload';
  else if (lower.includes('overloaded')) kind = 'overload';
  else if (lower.includes('rate_limit')) kind = 'rate_limit';
  else if (lower.includes('timeout') || lower.includes('abort')) kind = 'timeout';
  return new AiError({
    kind,
    provider: 'anthropic',
    status,
    message: `Anthropic ${status ?? '?'}: ${msg.slice(0, 500)}`,
    cause,
  });
}
