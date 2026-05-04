/**
 * No-op provider. Used by tests + the router's "no provider configured"
 * fallback path so the gateway never returns undefined.
 *
 * Behavior is configurable so tests can assert against specific shapes:
 *   - `mode: 'echo'` (default) — returns canned text mirroring the prompt
 *   - `mode: 'fail'` — throws AiError with the configured kind
 *
 * Cost is always 0 micros; latency is configurable for breaker / timeout
 * tests.
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

export type NoopMode =
  | { kind: 'echo'; latency_ms?: number; canned_text?: string; canned_data?: unknown }
  | { kind: 'fail'; error_kind: AiErrorKind; latency_ms?: number; message?: string };

export class NoopProvider implements AiProvider {
  readonly name = 'noop' as const;
  private mode: NoopMode;

  constructor(mode: NoopMode = { kind: 'echo' }) {
    this.mode = mode;
  }

  /** Swap behavior at runtime — useful for sequential test scenarios. */
  setMode(mode: NoopMode): void {
    this.mode = mode;
  }

  async callChat(req: ChatRequest): Promise<ChatResponse> {
    await this.delay();
    this.maybeFail();
    if (this.mode.kind !== 'echo') throw new Error('unreachable');
    return {
      kind: 'chat',
      provider: 'noop',
      model: req.model_override ?? 'noop-echo',
      api_key_label: 'noop',
      tokens_in: estimateTokens(req.messages.map((m) => m.content).join(' ')),
      tokens_out: estimateTokens(this.mode.canned_text ?? ''),
      cost_micros: BigInt(0),
      latency_ms: this.mode.latency_ms ?? 0,
      text: this.mode.canned_text ?? lastUserMessage(req.messages),
    };
  }

  async callVision(req: VisionRequest): Promise<VisionResponse> {
    await this.delay();
    this.maybeFail();
    if (this.mode.kind !== 'echo') throw new Error('unreachable');
    return {
      kind: 'vision',
      provider: 'noop',
      model: req.model_override ?? 'noop-echo',
      api_key_label: 'noop',
      tokens_in: estimateTokens(req.prompt) + 100, // pretend the image cost ~100 tokens
      tokens_out: estimateTokens(this.mode.canned_text ?? ''),
      cost_micros: BigInt(0),
      latency_ms: this.mode.latency_ms ?? 0,
      text:
        this.mode.canned_text ??
        `[noop vision: ${req.file?.mime ?? req.files?.[0]?.mime ?? 'no-file'}, ${req.prompt.slice(0, 32)}]`,
    };
  }

  async callTranscribe(req: TranscribeRequest): Promise<TranscribeResponse> {
    await this.delay();
    this.maybeFail();
    if (this.mode.kind !== 'echo') throw new Error('unreachable');
    return {
      kind: 'transcribe',
      provider: 'noop',
      model: req.model_override ?? 'noop-echo',
      api_key_label: 'noop',
      tokens_in: 100, // pretend the audio cost ~100 tokens
      tokens_out: estimateTokens(this.mode.canned_text ?? ''),
      cost_micros: BigInt(0),
      latency_ms: this.mode.latency_ms ?? 0,
      text: this.mode.canned_text ?? `[noop transcribe: ${req.file.mime}]`,
    };
  }

  async callStructured<T = unknown>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    await this.delay();
    this.maybeFail();
    if (this.mode.kind !== 'echo') throw new Error('unreachable');
    const data = (this.mode.canned_data ?? {}) as T;
    const rawText = JSON.stringify(data);
    return {
      kind: 'structured',
      provider: 'noop',
      model: req.model_override ?? 'noop-echo',
      api_key_label: 'noop',
      tokens_in: estimateTokens(req.prompt),
      tokens_out: estimateTokens(rawText),
      cost_micros: BigInt(0),
      latency_ms: this.mode.latency_ms ?? 0,
      data: req.parse ? req.parse(data) : data,
      raw_text: rawText,
    };
  }

  private async delay(): Promise<void> {
    const ms = this.mode.kind === 'echo' ? this.mode.latency_ms : this.mode.latency_ms;
    if (ms && ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  private maybeFail(): void {
    if (this.mode.kind !== 'fail') return;
    throw new AiError({
      kind: this.mode.error_kind,
      provider: 'noop',
      message: this.mode.message ?? `noop provider configured to fail with ${this.mode.error_kind}`,
    });
  }
}

function lastUserMessage(messages: Array<{ role: string; content: string }>): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

/** Cheap token estimate (~4 chars/token) — only used by the noop provider. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
