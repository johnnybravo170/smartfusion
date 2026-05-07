/**
 * Provider dispatch + the tiny config that decides which model and provider
 * to use for each board call kind. Keep model strings here, not buried in
 * the discussion engine, so swapping is one-file-edit easy.
 */

import { AnthropicLlmProvider } from './anthropic';
import { OpenRouterLlmProvider } from './openrouter';
import type { LlmProvider, LlmProviderName, LlmRequest, LlmResponse } from './types';

export { AnthropicLlmProvider } from './anthropic';
export { OpenRouterLlmProvider } from './openrouter';
export * from './types';

let CACHED: Partial<Record<LlmProviderName, LlmProvider>> = {};

export function getProvider(name: LlmProviderName): LlmProvider {
  const existing = CACHED[name];
  if (existing) return existing;
  const fresh = name === 'anthropic' ? new AnthropicLlmProvider() : new OpenRouterLlmProvider();
  CACHED[name] = fresh;
  return fresh;
}

export function resetProvidersForTests(): void {
  CACHED = {};
}

/** What kind of board turn is this? Used to pick the model. */
export type BoardCallKind =
  | 'advisor_opening'
  | 'advisor_exchange'
  | 'advisor_challenge'
  | 'advisor_position'
  | 'chair_extract_cruxes'
  | 'chair_turn'
  | 'chair_synthesis'
  | 'context_summary';

export type BoardModelChoice = {
  provider: LlmProviderName;
  model: string;
};

// Defaults. Override per-session via board_sessions.provider_override +
// model_override. Adding a new model means editing this map.
export const DEFAULT_BOARD_MODELS: Record<BoardCallKind, BoardModelChoice> = {
  advisor_opening: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  advisor_exchange: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  advisor_challenge: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  advisor_position: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  chair_extract_cruxes: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  chair_turn: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  chair_synthesis: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  context_summary: { provider: 'anthropic', model: 'claude-haiku-4-5' },
};

// Kimi preset. Pinned to k2.6 (Apr 2026). Bumped from k2.5 in May 2026
// when Moonshot announced the kimi-k2 series (k2-thinking, k2-0905,
// k2-turbo, k2-thinking-turbo, k2-0711) was being discontinued
// 2026-05-25. k2.5 wasn't explicitly on the kill list but the "k2
// series" headline language was ambiguous — k2.6 is newer (262K ctx)
// and now-canonical at $0.74/$3.49 per M tokens.
//
// We pin an explicit version rather than `kimi-latest` so version
// jumps are deliberate (we want to know when our preset's behavior
// shifts under us). Re-evaluate when k2.7 / k3 ships.
export const KIMI_MODEL = 'moonshotai/kimi-k2.6';
export const KIMI_PRESET: Partial<Record<BoardCallKind, BoardModelChoice>> = {
  advisor_opening: { provider: 'openrouter', model: KIMI_MODEL },
  advisor_exchange: { provider: 'openrouter', model: KIMI_MODEL },
  advisor_challenge: { provider: 'openrouter', model: KIMI_MODEL },
  advisor_position: { provider: 'openrouter', model: KIMI_MODEL },
};

export function pickModel(
  kind: BoardCallKind,
  overrides: { provider?: string | null; model?: string | null } | null = null,
  preset?: Partial<Record<BoardCallKind, BoardModelChoice>>,
): BoardModelChoice {
  const presetChoice = preset?.[kind];
  const def = presetChoice ?? DEFAULT_BOARD_MODELS[kind];
  if (overrides?.provider && overrides?.model) {
    if (overrides.provider !== 'anthropic' && overrides.provider !== 'openrouter') {
      throw new Error(`Unknown provider override: ${overrides.provider}`);
    }
    return { provider: overrides.provider, model: overrides.model };
  }
  return def;
}

export async function callLlm(
  choice: BoardModelChoice,
  req: Omit<LlmRequest, 'model'>,
): Promise<LlmResponse> {
  return getProvider(choice.provider).complete({ ...req, model: choice.model });
}
