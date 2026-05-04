/**
 * Public API surface for the AI gateway.
 *
 * Callers use `import { gateway } from '@/lib/ai-gateway'` and then
 * `gateway().runChat(...)` / runVision / runStructured / runTranscribe.
 * Per-task routing, fallback chains, circuit breaking, and telemetry
 * are handled inside; callers don't think about providers.
 *
 * Module map:
 *   - types.ts          public request/response types + AiProvider iface
 *   - errors.ts         AiError class + AiErrorKind
 *   - tasks.ts          KnownTask registry
 *   - routing.ts        per-task RouteConfig
 *   - router.ts         Gateway class + run* methods + lazy singleton
 *   - router-types.ts   RouteConfig, RouterHooks, RouterAttemptEvent
 *   - circuit-breaker.ts demote stuck providers for a recovery window
 *   - telemetry.ts      RouterHook → ai_calls writer
 *   - spend-tracker.ts  ai_calls reads for the admin dashboard
 *   - tier-ladders.ts   per-provider tier-climb math
 *   - providers/        per-provider adapters (openai, gemini,
 *                       anthropic, noop) + multi-key + cost helpers
 */

export { CircuitBreaker } from './circuit-breaker';
export type { AiErrorKind, ProviderName } from './errors';
export { AiError, defaultRetryable, isAiError } from './errors';
export { AnthropicProvider } from './providers/anthropic';
export { GeminiProvider } from './providers/gemini';
export type { ApiKey } from './providers/keys';
export { parseKeyEnv } from './providers/keys';
export type { NoopMode } from './providers/noop';
export { NoopProvider } from './providers/noop';
export { OpenAiProvider } from './providers/openai';
export type { GatewayOptions } from './router';
export { createGateway, Gateway, gateway, resetGatewayForTests } from './router';
export type {
  RouteConfig,
  RoutePick,
  RouterAttemptEvent,
  RouterHooks,
} from './router-types';
export { DEFAULT_ROUTE, lookupRoute, ROUTING } from './routing';
export type { SpendWindow } from './spend-tracker';
export {
  getProviderHealth,
  getProviderLifetime,
  getProviderSpendMicros,
  getRecentFailures,
  getTierProgress,
  getTopTasksByCostMtd,
} from './spend-tracker';
export type { KnownTask } from './tasks';
export { KNOWN_TASKS } from './tasks';
export type { AiCallRow, TelemetryHookOptions } from './telemetry';
export { createTelemetryHook } from './telemetry';
export type { TierProgress, TierStep } from './tier-ladders';
export {
  ANTHROPIC_LADDER,
  computeTierProgress,
  GEMINI_LADDER,
  getLadder,
  microsToUsd,
  OPENAI_LADDER,
} from './tier-ladders';
export type {
  AiProvider,
  AiRequestBase,
  AiResponseBase,
  AttachedFile,
  ChatMessage,
  ChatRequest,
  ChatResponse,
  StructuredRequest,
  StructuredResponse,
  TranscribeRequest,
  TranscribeResponse,
  VisionRequest,
  VisionResponse,
} from './types';
