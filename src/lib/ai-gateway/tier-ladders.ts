/**
 * Provider tier-climb ladders. Constants + pure math, no DB.
 *
 * Each provider has a usage-tier ladder where higher tiers unlock
 * higher rate limits and (sometimes) lower per-token rates. Tiers are
 * gated by:
 *   1. Cumulative paid amount (lifetime spend)
 *   2. Days since first payment (a maturity gate)
 *
 * The router's intentional "tier-climb traffic" (e.g. 30% of
 * receipt_ocr to OpenAI) only matters if we know where we stand on
 * each ladder. The admin dashboard surfaces this.
 *
 * Verified: 2026-05-03. Both providers have changed tier requirements
 * before; if you see a mismatch, update the constants here and bump
 * the verified date.
 *
 * NOTE: We use our internally-computed cost_micros as a proxy for
 * "amount paid." Rate-table drift from actual provider invoices is
 * usually <5% — fine for tier-progress estimation. For the actual
 * tier promotion you check the provider's billing dashboard.
 */

import type { ProviderName } from './errors';

export type TierStep = {
  /** Display name. */
  name: string;
  /** Cumulative USD spend required to reach this tier. */
  spend_usd: number;
  /** Days since first qualifying payment. */
  days_required: number;
};

// Sources verified 2026-05-03:
//   OpenAI: platform.openai.com/docs/guides/rate-limits/usage-tiers
//   Anthropic: docs.anthropic.com/en/api/rate-limits

export const OPENAI_LADDER: TierStep[] = [
  { name: 'Free', spend_usd: 0, days_required: 0 },
  { name: 'Tier 1', spend_usd: 5, days_required: 0 },
  { name: 'Tier 2', spend_usd: 50, days_required: 7 },
  { name: 'Tier 3', spend_usd: 100, days_required: 7 },
  { name: 'Tier 4', spend_usd: 250, days_required: 14 },
  { name: 'Tier 5', spend_usd: 1_000, days_required: 30 },
];

export const ANTHROPIC_LADDER: TierStep[] = [
  { name: 'Build (Tier 1)', spend_usd: 0, days_required: 0 },
  { name: 'Build (Tier 2)', spend_usd: 40, days_required: 7 },
  { name: 'Build (Tier 3)', spend_usd: 200, days_required: 7 },
  { name: 'Build (Tier 4)', spend_usd: 400, days_required: 14 },
  { name: 'Scale', spend_usd: 5_000, days_required: 30 },
];

// Gemini's paid tier doesn't have a published ladder in the same
// shape — usage-based pricing without explicit tier gates. Show
// lifetime spend without tier promotion math.
export const GEMINI_LADDER: TierStep[] = [{ name: 'Paid', spend_usd: 0, days_required: 0 }];

const LADDERS: Record<ProviderName, TierStep[]> = {
  openai: OPENAI_LADDER,
  anthropic: ANTHROPIC_LADDER,
  gemini: GEMINI_LADDER,
  noop: [{ name: 'Noop', spend_usd: 0, days_required: 0 }],
};

export function getLadder(provider: ProviderName): TierStep[] {
  return LADDERS[provider];
}

export type TierProgress = {
  provider: ProviderName;
  /** Tier the provider's billing dashboard would show right now. */
  current_tier: TierStep;
  /** Next step on the ladder, or null at the top. */
  next_tier: TierStep | null;
  /** Lifetime USD we've estimated based on ai_calls cost_micros. */
  lifetime_usd: number;
  /** Days since first qualifying call (oldest ai_calls row for provider). */
  days_since_first_payment: number;
  /** Dollars still needed before the next tier unlocks. */
  usd_remaining: number;
  /** Days still required by the next tier (0 if already met). */
  days_remaining: number;
  /** Are both gates satisfied? `next_tier` is reachable today. */
  ready_for_next: boolean;
};

/**
 * Pure compute — no IO. spend-tracker.ts collects
 * (lifetime_micros, first_call_iso) and hands them here.
 */
export function computeTierProgress(input: {
  provider: ProviderName;
  lifetime_micros: bigint;
  first_call_at: Date | null;
  now?: Date;
}): TierProgress {
  const ladder = LADDERS[input.provider];
  const now = input.now ?? new Date();
  const lifetime_usd = microsToUsd(input.lifetime_micros);
  const days_since_first_payment = input.first_call_at
    ? Math.max(0, Math.floor((now.getTime() - input.first_call_at.getTime()) / 86_400_000))
    : 0;

  // Find the highest ladder step we currently qualify for.
  let current_tier = ladder[0];
  for (const step of ladder) {
    if (lifetime_usd >= step.spend_usd && days_since_first_payment >= step.days_required) {
      current_tier = step;
    }
  }

  const currentIndex = ladder.indexOf(current_tier);
  const next_tier = currentIndex < ladder.length - 1 ? ladder[currentIndex + 1] : null;

  const usd_remaining = next_tier ? Math.max(0, next_tier.spend_usd - lifetime_usd) : 0;
  const days_remaining = next_tier
    ? Math.max(0, next_tier.days_required - days_since_first_payment)
    : 0;
  const ready_for_next = next_tier !== null && usd_remaining === 0 && days_remaining === 0;

  return {
    provider: input.provider,
    current_tier,
    next_tier,
    lifetime_usd,
    days_since_first_payment,
    usd_remaining,
    days_remaining,
    ready_for_next,
  };
}

/** Convert micros (millionths of a cent) to USD as a JS number. */
export function microsToUsd(micros: bigint): number {
  // micros / 1e6 = cents → cents / 100 = dollars
  // So usd = micros / 1e8. We use Number() because lifetime spend
  // for any one provider stays well below 2^53 micros (=~$90M).
  return Number(micros) / 1e8;
}
