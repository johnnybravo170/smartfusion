/**
 * Fire-and-forget AI call telemetry for ops.
 *
 * Writes to public.ai_calls — the same table the main app's gateway writes
 * to — so the /admin/ai-gateway dashboard shows ops spend alongside app
 * spend without any dashboard changes.
 *
 * Ops calls are platform-level (no tenant_id). They appear in the "Top
 * tasks by cost MTD" and "Last 50 failures" panels with task names
 * prefixed "ops:".
 */

import { createServiceClient } from '@/lib/supabase';

export type OpsAiCallOpts = {
  task: string;
  provider: string;
  model: string;
  status: 'success' | 'error';
  tokens_in?: number | null;
  tokens_out?: number | null;
  /** Cost in USD cents. Converted to cost_micros before insert. */
  cost_cents?: number | null;
  latency_ms: number;
  error_message?: string | null;
};

/**
 * Fire-and-forget insert to public.ai_calls.
 * Never throws — telemetry must never fail the calling operation.
 */
export function trackOpsAiCall(opts: OpsAiCallOpts): void {
  const cost_micros = opts.cost_cents != null ? Math.round(opts.cost_cents * 1_000_000) : null;

  createServiceClient()
    .from('ai_calls')
    .insert({
      task: opts.task,
      provider: opts.provider,
      model: opts.model,
      status: opts.status,
      attempt_index: 0,
      tokens_in: opts.tokens_in ?? null,
      tokens_out: opts.tokens_out ?? null,
      cost_micros,
      latency_ms: opts.latency_ms,
      error_message: opts.error_message ?? null,
      // tenant_id omitted — NULL for ops (platform-level, not tenant-scoped)
    })
    .then(({ error }) => {
      if (error) console.error('[ops telemetry] ai_calls insert failed:', error.message);
    });
}

// ---------------------------------------------------------------------------
// Cost helpers (USD per million tokens → cents)
// ---------------------------------------------------------------------------

/** Anthropic Sonnet 4.6 ($3/M in, $15/M out). */
export function anthropicSonnetCostCents(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * 3 * 100 + (tokensOut / 1_000_000) * 15 * 100;
}

/** Anthropic Haiku 4.5 ($0.80/M in, $4/M out). */
export function anthropicHaikuCostCents(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * 0.8 * 100 + (tokensOut / 1_000_000) * 4 * 100;
}

/** Gemini 2.5 Flash ($0.15/M in ≤200K ctx, $0.60/M out non-thinking). */
export function geminiFlashCostCents(tokensIn: number, tokensOut: number): number {
  return (tokensIn / 1_000_000) * 0.15 * 100 + (tokensOut / 1_000_000) * 0.6 * 100;
}
