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

// Useful preset for the "let's try Kimi for fun" experiment. Override at
// session creation: { provider_override: 'openrouter', model_override:
// 'moonshotai/kimi-k2-thinking' }. Chair stays on Sonnet so the imprint
// caching still works; only advisors and orchestration go to Kimi.
export const KIMI_PRESET: Partial<Record<BoardCallKind, BoardModelChoice>> = {
  advisor_opening: { provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking' },
  advisor_exchange: { provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking' },
  advisor_challenge: { provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking' },
  advisor_position: { provider: 'openrouter', model: 'moonshotai/kimi-k2-thinking' },
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
