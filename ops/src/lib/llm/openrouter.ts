/**
 * OpenRouter provider. One API for many models. We use it for:
 *   - Kimi (moonshotai/kimi-k2-thinking, etc.) — fun + cheap A/B comparisons
 *   - DeepSeek, Llama, etc. for future experiments
 *
 * Model IDs are passed through verbatim (req.model). Pricing is fetched
 * from OpenRouter on first use and cached in-process; falls back to a
 * conservative cents-per-1k-tokens estimate when the API hiccups so we
 * never silently zero out the cost.
 */

import {
  LlmError,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  tokensToCents,
} from './types';

type OrPricing = { prompt: number; completion: number }; // USD per token

const PRICING_CACHE = new Map<string, OrPricing>();
let PRICING_FETCHED_AT = 0;
const PRICING_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function fetchPricing(): Promise<void> {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return;
    const json = (await res.json()) as {
      data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
    };
    for (const m of json.data ?? []) {
      const p = Number(m.pricing?.prompt ?? 0);
      const c = Number(m.pricing?.completion ?? 0);
      if (Number.isFinite(p) && Number.isFinite(c)) {
        PRICING_CACHE.set(m.id, { prompt: p, completion: c });
      }
    }
    PRICING_FETCHED_AT = Date.now();
  } catch {
    // best-effort
  }
}

async function getRate(model: string): Promise<{ in_per_m: number; out_per_m: number }> {
  if (Date.now() - PRICING_FETCHED_AT > PRICING_TTL_MS) {
    await fetchPricing();
  }
  const p = PRICING_CACHE.get(model);
  if (p) {
    return { in_per_m: p.prompt * 1_000_000, out_per_m: p.completion * 1_000_000 };
  }
  // Conservative fallback: $5/M in, $15/M out. Worse-than-actual is fine
  // because the budget cap fails closed; better-than-actual would let
  // sessions overrun the cap.
  return { in_per_m: 5, out_per_m: 15 };
}

export class OpenRouterLlmProvider implements LlmProvider {
  readonly name = 'openrouter' as const;
  private apiKey: string;
  private referer: string;
  private appTitle: string;

  constructor(opts?: { apiKey?: string; referer?: string; appTitle?: string }) {
    const key = opts?.apiKey ?? process.env.OPENROUTER_API_KEY;
    if (!key) throw new LlmError('OPENROUTER_API_KEY not set', 'openrouter');
    this.apiKey = key;
    this.referer = opts?.referer ?? 'https://ops.heyhenry.io';
    this.appTitle = opts?.appTitle ?? 'HeyHenry Board';
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const t0 = Date.now();
    const messages: Array<{ role: string; content: string }> = [];

    // OpenRouter uses OpenAI's chat-completions schema: system as a leading
    // message. Cache markers in the system block are dropped (only Anthropic
    // honors them today), but we preserve text content.
    const system = flattenSystem(req.system);
    if (system) messages.push({ role: 'system', content: system });
    for (const m of req.messages) messages.push({ role: m.role, content: m.content });

    let res: Response;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), req.timeout_ms ?? 120_000);
      try {
        res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': this.referer,
            'X-Title': this.appTitle,
          },
          body: JSON.stringify({
            model: req.model,
            messages,
            temperature: req.temperature ?? 0.7,
            max_tokens: req.max_tokens ?? 1024,
            ...(req.json ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      throw new LlmError(
        `OpenRouter network error: ${err instanceof Error ? err.message : String(err)}`,
        'openrouter',
        undefined,
        true,
      );
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const retryable = res.status >= 500 || res.status === 429;
      throw new LlmError(
        `OpenRouter ${res.status}: ${body.slice(0, 500)}`,
        'openrouter',
        res.status,
        retryable,
      );
    }

    const data = (await res.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = (data.choices?.[0]?.message?.content ?? '').trim();
    const tokens_in = data.usage?.prompt_tokens ?? 0;
    const tokens_out = data.usage?.completion_tokens ?? 0;

    const { in_per_m, out_per_m } = await getRate(req.model);
    return {
      provider: 'openrouter',
      model: data.model ?? req.model,
      text,
      prompt_tokens: tokens_in,
      completion_tokens: tokens_out,
      cost_cents: tokensToCents(tokens_in, tokens_out, in_per_m, out_per_m),
      latency_ms: Date.now() - t0,
    };
  }
}

function flattenSystem(system: LlmRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  const arr = Array.isArray(system) ? system : [system];
  return (
    arr
      .map((b) => (typeof b === 'string' ? b : b.text))
      .filter(Boolean)
      .join('\n\n') || undefined
  );
}
