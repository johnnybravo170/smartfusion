/**
 * OpenAI adapter. Uses raw fetch (no `openai` package dependency).
 *
 * Endpoints:
 *   - Chat / Vision / Structured: POST /v1/chat/completions
 *
 * Vision: image and PDF both ride the chat-completions multimodal API
 * via the `image_url` / `file` content block (PDFs are base64 inline
 * up to 32MB — same shape we used in the pre-Gemini extract-receipt).
 *
 * Structured: uses `response_format: { type: 'json_schema', strict: true }`
 * to enforce the schema server-side.
 *
 * Rates verified 2026-05-03 from openai.com/pricing.
 */

import { AiError, type AiErrorKind } from '../errors';
import type {
  AiProvider,
  ChatRequest,
  ChatResponse,
  StructuredRequest,
  StructuredResponse,
  TranscribeRequest,
  TranscribeResponse,
  VisionRequest,
  VisionResponse,
} from '../types';
import { computeCostMicros, lookupRates, type ModelRates, usdPerMillionToMicros } from './cost';
import { type ApiKey, parseKeyEnv, pickKey } from './keys';

// USD per million tokens. Output rates are typically 4-5× input.
const RATES: Record<string, ModelRates> = {
  'gpt-4o-mini': {
    input_micros_per_token: usdPerMillionToMicros(0.15),
    output_micros_per_token: usdPerMillionToMicros(0.6),
  },
  'gpt-4o': {
    input_micros_per_token: usdPerMillionToMicros(2.5),
    output_micros_per_token: usdPerMillionToMicros(10),
  },
  'gpt-4.1-mini': {
    input_micros_per_token: usdPerMillionToMicros(0.4),
    output_micros_per_token: usdPerMillionToMicros(1.6),
  },
  'gpt-4.1': {
    input_micros_per_token: usdPerMillionToMicros(2),
    output_micros_per_token: usdPerMillionToMicros(8),
  },
  'o3-mini': {
    input_micros_per_token: usdPerMillionToMicros(1.1),
    output_micros_per_token: usdPerMillionToMicros(4.4),
  },
  // Audio transcription models: input rate is per-audio-token, output
  // is the text transcript. Higher input rate than text models because
  // audio takes more tokens to encode.
  'gpt-4o-transcribe': {
    input_micros_per_token: usdPerMillionToMicros(6),
    output_micros_per_token: usdPerMillionToMicros(10),
  },
  'gpt-4o-mini-transcribe': {
    input_micros_per_token: usdPerMillionToMicros(3),
    output_micros_per_token: usdPerMillionToMicros(5),
  },
  // Default for unknown / unlisted models — assume gpt-4o-mini-ish.
  '*': {
    input_micros_per_token: usdPerMillionToMicros(0.15),
    output_micros_per_token: usdPerMillionToMicros(0.6),
  },
};

const DEFAULT_MODELS = {
  chat: 'gpt-4o-mini',
  vision: 'gpt-4o-mini',
  structured: 'gpt-4o-mini',
  transcribe: 'gpt-4o-transcribe',
};

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const TRANSCRIBE_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;
  private keys: ApiKey[];

  constructor(opts?: { keys?: ApiKey[] }) {
    this.keys = opts?.keys ?? parseKeyEnv(process.env.OPENAI_API_KEYS, process.env.OPENAI_API_KEY);
  }

  async callChat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.chat;
    const messages = req.system
      ? [{ role: 'system', content: req.system }, ...req.messages]
      : req.messages;
    const { json, key, latency_ms } = await this.post({
      model,
      messages,
      temperature: req.temperature,
      max_tokens: req.max_tokens,
      timeout_ms: req.timeout_ms,
    });
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      kind: 'chat',
      provider: 'openai',
      model: json.model ?? model,
      api_key_label: key.label,
      tokens_in: json.usage?.prompt_tokens ?? 0,
      tokens_out: json.usage?.completion_tokens ?? 0,
      cost_micros: computeCostMicros(
        json.usage?.prompt_tokens ?? 0,
        json.usage?.completion_tokens ?? 0,
        lookupRates(RATES, json.model ?? model),
      ),
      latency_ms,
      text,
    };
  }

  async callVision(req: VisionRequest): Promise<VisionResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.vision;
    const allFiles = filesOf(req);
    const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
    for (const f of allFiles) userContent.push(toOpenAiFilePart(f));
    const { json, key, latency_ms } = await this.post({
      model,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: req.max_tokens,
      timeout_ms: req.timeout_ms,
    });
    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      kind: 'vision',
      provider: 'openai',
      model: json.model ?? model,
      api_key_label: key.label,
      tokens_in: json.usage?.prompt_tokens ?? 0,
      tokens_out: json.usage?.completion_tokens ?? 0,
      cost_micros: computeCostMicros(
        json.usage?.prompt_tokens ?? 0,
        json.usage?.completion_tokens ?? 0,
        lookupRates(RATES, json.model ?? model),
      ),
      latency_ms,
      text,
    };
  }

  async callStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const model = req.model_override ?? DEFAULT_MODELS.structured;
    const userContent: Array<Record<string, unknown>> = [{ type: 'text', text: req.prompt }];
    for (const f of filesOf(req)) userContent.push(toOpenAiFilePart(f));
    const { json, key, latency_ms } = await this.post({
      model,
      messages: [{ role: 'user', content: userContent }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'gateway_response',
          strict: true,
          schema: req.schema,
        },
      },
      temperature: req.temperature,
      timeout_ms: req.timeout_ms,
    });
    const rawText = json.choices?.[0]?.message?.content ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'openai',
        message: 'OpenAI returned non-JSON for a structured request.',
      });
    }
    let data: T;
    try {
      data = req.parse ? req.parse(parsed) : (parsed as T);
    } catch (cause) {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'openai',
        message: cause instanceof Error ? cause.message : 'parse() rejected response',
        cause,
      });
    }
    return {
      kind: 'structured',
      provider: 'openai',
      model: json.model ?? model,
      api_key_label: key.label,
      tokens_in: json.usage?.prompt_tokens ?? 0,
      tokens_out: json.usage?.completion_tokens ?? 0,
      cost_micros: computeCostMicros(
        json.usage?.prompt_tokens ?? 0,
        json.usage?.completion_tokens ?? 0,
        lookupRates(RATES, json.model ?? model),
      ),
      latency_ms,
      data,
      raw_text: rawText,
    };
  }

  async callTranscribe(req: TranscribeRequest): Promise<TranscribeResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.transcribe;
    const key = pickKey('openai', this.keys);
    if (!key) {
      throw new AiError({
        kind: 'auth',
        provider: 'openai',
        message: 'No OpenAI API key configured (OPENAI_API_KEYS or OPENAI_API_KEY).',
      });
    }

    const form = new FormData();
    form.set(
      'file',
      new Blob([Buffer.from(req.file.base64, 'base64')], { type: req.file.mime }),
      req.file.filename ?? 'audio',
    );
    form.set('model', model);
    if (req.prompt) form.set('prompt', req.prompt);
    if (req.language) form.set('language', req.language);
    // gpt-4o-transcribe defaults to JSON; ask for verbose to capture usage.
    form.set('response_format', 'json');

    const ac = new AbortController();
    const timer =
      req.timeout_ms && req.timeout_ms > 0 ? setTimeout(() => ac.abort(), req.timeout_ms) : null;
    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(TRANSCRIBE_ENDPOINT, {
        method: 'POST',
        signal: ac.signal,
        headers: { Authorization: `Bearer ${key.secret}` },
        body: form,
      });
    } catch (cause) {
      const aborted = (cause as { name?: string })?.name === 'AbortError';
      throw new AiError({
        kind: aborted ? 'timeout' : 'unknown',
        provider: 'openai',
        message: aborted
          ? 'OpenAI transcribe timed out.'
          : `OpenAI transcribe failed: ${String(cause)}`,
        cause,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyOpenAiError(res.status, text);
    }
    const json = (await res.json()) as {
      text?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    const tokens_in = json.usage?.input_tokens ?? 0;
    const tokens_out = json.usage?.output_tokens ?? 0;
    return {
      kind: 'transcribe',
      provider: 'openai',
      model,
      api_key_label: key.label,
      tokens_in,
      tokens_out,
      cost_micros: computeCostMicros(tokens_in, tokens_out, lookupRates(RATES, model)),
      latency_ms,
      text: json.text ?? '',
    };
  }

  // ------------------------------------------------------------------
  // POST + error classification
  // ------------------------------------------------------------------

  private async post(body: Record<string, unknown> & { timeout_ms?: number }): Promise<{
    json: any;
    key: ApiKey;
    latency_ms: number;
  }> {
    const key = pickKey('openai', this.keys);
    if (!key) {
      throw new AiError({
        kind: 'auth',
        provider: 'openai',
        message: 'No OpenAI API key configured (OPENAI_API_KEYS or OPENAI_API_KEY).',
      });
    }
    const { timeout_ms, ...rest } = body;
    const ac = new AbortController();
    const timer = timeout_ms && timeout_ms > 0 ? setTimeout(() => ac.abort(), timeout_ms) : null;
    const start = Date.now();
    let res: Response;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${key.secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(rest),
      });
    } catch (cause) {
      const aborted = (cause as { name?: string })?.name === 'AbortError';
      throw new AiError({
        kind: aborted ? 'timeout' : 'unknown',
        provider: 'openai',
        message: aborted ? 'OpenAI request timed out.' : `OpenAI fetch failed: ${String(cause)}`,
        cause,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const latency_ms = Date.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyOpenAiError(res.status, text);
    }
    const json = await res.json();
    return { json, key, latency_ms };
  }
}

function filesOf(req: {
  file?: { mime: string; base64: string; filename?: string };
  files?: Array<{ mime: string; base64: string; filename?: string }>;
}) {
  const out: Array<{ mime: string; base64: string; filename?: string }> = [];
  if (req.file) out.push(req.file);
  if (req.files) out.push(...req.files);
  return out;
}

function toOpenAiFilePart(f: {
  mime: string;
  base64: string;
  filename?: string;
}): Record<string, unknown> {
  if (f.mime === 'application/pdf') {
    return {
      type: 'file',
      file: {
        filename: f.filename ?? 'input.pdf',
        file_data: `data:application/pdf;base64,${f.base64}`,
      },
    };
  }
  return {
    type: 'image_url',
    image_url: { url: `data:${f.mime};base64,${f.base64}` },
  };
}

function classifyOpenAiError(status: number, body: string): AiError {
  const lower = body.toLowerCase();
  let kind: AiErrorKind = 'unknown';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 400) kind = 'invalid_input';
  else if (status === 429) {
    kind = lower.includes('insufficient_quota') ? 'quota' : 'rate_limit';
  } else if (status >= 500) {
    kind = 'overload';
  }
  return new AiError({
    kind,
    provider: 'openai',
    status,
    message: `OpenAI ${status}: ${body.slice(0, 500) || 'no body'}`,
  });
}
