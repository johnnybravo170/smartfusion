/**
 * Public API surface for the AI gateway.
 *
 * AG-1 ships only the contract — types + error class + a noop provider.
 * The actual `gateway.run(...)` entry point lives in AG-3 (router); the
 * concrete OpenAI / Gemini / Anthropic adapters in AG-2.
 *
 * Migration path (AG-7): callers switch from direct provider SDK imports
 * to `import { gateway } from '@/lib/ai-gateway'` once AG-3 lands.
 */

export type { AiErrorKind, ProviderName } from './errors';
export { AiError, defaultRetryable, isAiError } from './errors';
export { AnthropicProvider } from './providers/anthropic';
export { GeminiProvider } from './providers/gemini';
export type { ApiKey } from './providers/keys';
export { parseKeyEnv } from './providers/keys';
export type { NoopMode } from './providers/noop';
export { NoopProvider } from './providers/noop';
export { OpenAiProvider } from './providers/openai';
export type { KnownTask } from './tasks';
export { KNOWN_TASKS } from './tasks';
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
  VisionRequest,
  VisionResponse,
} from './types';
