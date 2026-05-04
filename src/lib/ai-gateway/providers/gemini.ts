/**
 * Gemini adapter using @google/genai. Already a repo dependency; the
 * SDK handles JSON-mode + multimodal cleanly.
 *
 * Rates verified 2026-05-03 from ai.google.dev/pricing (paid tier).
 */

import { GoogleGenAI } from '@google/genai';
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
  'gemini-2.5-flash': {
    input_micros_per_token: usdPerMillionToMicros(0.075),
    output_micros_per_token: usdPerMillionToMicros(0.3),
  },
  'gemini-2.5-flash-lite': {
    input_micros_per_token: usdPerMillionToMicros(0.0375),
    output_micros_per_token: usdPerMillionToMicros(0.15),
  },
  'gemini-2.5-pro': {
    input_micros_per_token: usdPerMillionToMicros(1.25),
    output_micros_per_token: usdPerMillionToMicros(5),
  },
  'gemini-1.5-flash': {
    input_micros_per_token: usdPerMillionToMicros(0.075),
    output_micros_per_token: usdPerMillionToMicros(0.3),
  },
  'gemini-1.5-pro': {
    input_micros_per_token: usdPerMillionToMicros(1.25),
    output_micros_per_token: usdPerMillionToMicros(5),
  },
  '*': {
    input_micros_per_token: usdPerMillionToMicros(0.075),
    output_micros_per_token: usdPerMillionToMicros(0.3),
  },
};

const DEFAULT_MODELS = {
  chat: 'gemini-2.5-flash',
  vision: 'gemini-2.5-flash',
  structured: 'gemini-2.5-flash',
};

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  private keys: ApiKey[];

  constructor(opts?: { keys?: ApiKey[] }) {
    this.keys = opts?.keys ?? parseKeyEnv(process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY);
  }

  async callChat(req: ChatRequest): Promise<ChatResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.chat;
    const { response, key, latency_ms } = await this.run(async (ai) => {
      const contents = req.messages.map((m) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }],
      }));
      return ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction: req.system,
          temperature: req.temperature,
          maxOutputTokens: req.max_tokens,
        },
      });
    });
    return this.shapeText('chat', response, model, key, latency_ms);
  }

  async callVision(req: VisionRequest): Promise<VisionResponse> {
    const model = req.model_override ?? DEFAULT_MODELS.vision;
    const allFiles = filesOf(req);
    const { response, key, latency_ms } = await this.run(async (ai) => {
      return ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [
              { text: req.prompt },
              ...allFiles.map((f) => ({ inlineData: { mimeType: f.mime, data: f.base64 } })),
            ],
          },
        ],
        config: {
          maxOutputTokens: req.max_tokens,
        },
      });
    });
    return this.shapeText('vision', response, model, key, latency_ms);
  }

  async callStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    const model = req.model_override ?? DEFAULT_MODELS.structured;
    const allFiles = filesOf(req);
    const { response, key, latency_ms } = await this.run(async (ai) => {
      const parts: Array<Record<string, unknown>> = [{ text: req.prompt }];
      for (const f of allFiles) parts.push({ inlineData: { mimeType: f.mime, data: f.base64 } });
      return ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: req.schema,
          temperature: req.temperature ?? 0.1,
        },
      });
    });
    const rawText = response.text ?? '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'gemini',
        message: 'Gemini returned non-JSON for a structured request.',
      });
    }
    let data: T;
    try {
      data = req.parse ? req.parse(parsed) : (parsed as T);
    } catch (cause) {
      throw new AiError({
        kind: 'invalid_input',
        provider: 'gemini',
        message: cause instanceof Error ? cause.message : 'parse() rejected response',
        cause,
      });
    }
    const { tokens_in, tokens_out } = extractUsage(response);
    return {
      kind: 'structured',
      provider: 'gemini',
      model,
      api_key_label: key.label,
      tokens_in,
      tokens_out,
      cost_micros: computeCostMicros(tokens_in, tokens_out, lookupRates(RATES, model)),
      latency_ms,
      data,
      raw_text: rawText,
    };
  }

  // ------------------------------------------------------------------

  private shapeText<K extends 'chat' | 'vision'>(
    kind: K,
    response: GenerateContentResponse,
    model: string,
    key: ApiKey,
    latency_ms: number,
  ): K extends 'chat' ? ChatResponse : VisionResponse {
    const { tokens_in, tokens_out } = extractUsage(response);
    const text = response.text ?? '';
    return {
      kind,
      provider: 'gemini',
      model,
      api_key_label: key.label,
      tokens_in,
      tokens_out,
      cost_micros: computeCostMicros(tokens_in, tokens_out, lookupRates(RATES, model)),
      latency_ms,
      text,
    } as K extends 'chat' ? ChatResponse : VisionResponse;
  }

  private async run<T>(
    fn: (ai: GoogleGenAI) => Promise<T>,
  ): Promise<{ response: T; key: ApiKey; latency_ms: number }> {
    const key = pickKey('gemini', this.keys);
    if (!key) {
      throw new AiError({
        kind: 'auth',
        provider: 'gemini',
        message: 'No Gemini API key configured (GEMINI_API_KEYS or GEMINI_API_KEY).',
      });
    }
    const ai = new GoogleGenAI({ apiKey: key.secret });
    const start = Date.now();
    try {
      const response = await fn(ai);
      return { response, key, latency_ms: Date.now() - start };
    } catch (cause) {
      throw classifyGeminiError(cause);
    }
  }
}

/**
 * Combine `file` (singular) + `files` (multi) into one ordered list.
 * Singular comes first so the existing single-file callers see the
 * same behavior; multi-file callers should use `files` exclusively.
 */
function filesOf(req: {
  file?: { mime: string; base64: string };
  files?: Array<{ mime: string; base64: string }>;
}) {
  const out: Array<{ mime: string; base64: string }> = [];
  if (req.file) out.push(req.file);
  if (req.files) out.push(...req.files);
  return out;
}

type GenerateContentResponse = {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function extractUsage(response: GenerateContentResponse): {
  tokens_in: number;
  tokens_out: number;
} {
  const u = response.usageMetadata ?? {};
  return {
    tokens_in: u.promptTokenCount ?? 0,
    tokens_out: u.candidatesTokenCount ?? 0,
  };
}

function classifyGeminiError(cause: unknown): AiError {
  const msg = cause instanceof Error ? cause.message : String(cause);
  let kind: AiErrorKind = 'unknown';
  if (/RESOURCE_EXHAUSTED|insufficient_quota|quota/i.test(msg)) kind = 'quota';
  else if (/UNAVAILABLE|503|overload/i.test(msg)) kind = 'overload';
  else if (/429|rate.?limit/i.test(msg)) kind = 'rate_limit';
  else if (/401|403|unauthor|permission/i.test(msg)) kind = 'auth';
  else if (/400|invalid/i.test(msg)) kind = 'invalid_input';
  else if (/timeout|abort/i.test(msg)) kind = 'timeout';
  return new AiError({
    kind,
    provider: 'gemini',
    message: `Gemini error: ${msg.slice(0, 500)}`,
    cause,
  });
}
