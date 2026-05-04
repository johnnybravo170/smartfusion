/**
 * Per-task routing config. Edited by hand — no UI for now. Adding a
 * new task means appending to `tasks.ts` and a row here; unknown tasks
 * fall through to `DEFAULT_ROUTE`.
 *
 * Strategic notes:
 *  - `secondary` weights are the *intentional tier-climb traffic* — we
 *    over-route a slice to OpenAI / Anthropic so HeyHenry's spend
 *    keeps flowing into those tier ladders.
 *  - `fallback_chain` order matters: cheapest first usually, but for
 *    quality-sensitive tasks (e.g. project_memo) we order by capability.
 *  - The current per-task primaries reflect "preserve the original
 *    provider at migration time." See the v1 roadmap item
 *    "Re-evaluate AI gateway routing config against telemetry" for the
 *    post-launch tuning pass against real numbers.
 */

import type { RouteConfig } from './router-types';
import type { KnownTask } from './tasks';

export const DEFAULT_ROUTE: RouteConfig = {
  primary: { provider: 'gemini' },
  fallback_chain: ['gemini', 'anthropic', 'openai'],
};

export const ROUTING: Record<KnownTask, RouteConfig> = {
  // Highest-volume task. Gemini Flash dominates on cost; route 30% to
  // OpenAI gpt-4o-mini for tier-climb. Both are fine on receipt OCR.
  receipt_ocr: {
    primary: { provider: 'gemini' },
    secondary: { provider: 'openai', weight: 0.3 },
    fallback_chain: ['gemini', 'openai', 'anthropic'],
  },

  // Lower volume — tier-climb traffic isn't worth the extra cost on
  // these. Gemini handles cheques + e-transfer screenshots well.
  invoice_payment_ocr: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'anthropic', 'openai'],
  },

  // Stage 1 — audio → transcript. Gemini Flash is the only option that
  // accepts webm inline today (Anthropic's audio path was 400ing on
  // non-PDF document blocks pre-Apr 2026); also basically free. The
  // call is plain vision with prompt = "transcribe only", text out.
  project_memo_transcribe: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini'],
  },

  // Stage 2 — transcript + photos → structured work items. Sonnet 4.6
  // is the default: schema-constrained extraction at near-Opus quality
  // for ~5x less cost and 2-3x the speed. ~$0.03/call typical.
  project_memo_extract: {
    primary: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    fallback_chain: ['anthropic', 'gemini'],
  },

  // Stage 2 second pass — Opus 4.7 with extended thinking. User-
  // triggered ("Have another think" button). Two real lifts over the
  // first pass: bigger model + thinking on. ~$0.15-0.30/call.
  project_memo_extract_thinking: {
    primary: { provider: 'anthropic', model: 'claude-opus-4-7' },
    fallback_chain: ['anthropic'],
  },

  // High-volume but throwaway (one classification per inbound email).
  // Gemini Flash is plenty.
  email_classify: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'openai'],
  },

  // OpenAI primary preserved from the legacy coa-mapping flow.
  // Routing-tune roadmap entry covers re-evaluation.
  coa_account_suggest: {
    primary: { provider: 'openai' },
    secondary: { provider: 'gemini', weight: 0.5 },
    fallback_chain: ['openai', 'gemini', 'anthropic'],
  },

  inbound_lead_enrich: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'anthropic'],
  },

  sub_quote_parse: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'anthropic', 'openai'],
  },

  scope_scaffold: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },

  pulse_progress_draft: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },
  document_type_classify: {
    primary: { provider: 'anthropic' },
    secondary: { provider: 'gemini', weight: 0.5 },
    fallback_chain: ['anthropic', 'gemini'],
  },
  decision_suggest: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },
  photo_classify_internal: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },
  photo_label_homeowner: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },
  overhead_expense_extract: {
    primary: { provider: 'openai' },
    secondary: { provider: 'gemini', weight: 0.5 },
    fallback_chain: ['openai', 'gemini', 'anthropic'],
  },
  contact_parse_intake: {
    primary: { provider: 'openai' },
    fallback_chain: ['openai', 'gemini', 'anthropic'],
  },
  intake_augment_suggest: {
    primary: { provider: 'openai' },
    fallback_chain: ['openai', 'gemini', 'anthropic'],
  },
  note_reply_draft: {
    primary: { provider: 'openai' },
    secondary: { provider: 'gemini', weight: 0.4 },
    fallback_chain: ['openai', 'gemini', 'anthropic'],
  },

  // Audio transcription is OpenAI-only (Whisper / gpt-4o-transcribe).
  // Gemini and Anthropic don't expose a dedicated transcription
  // primitive — both throw `invalid_input` if routed here. No fallback.
  audio_transcribe_intake: {
    primary: { provider: 'openai' },
    fallback_chain: ['openai'],
  },
  // Full intake parse uses Anthropic tool-use under the hood (the
  // Anthropic adapter applies it automatically when `runStructured`
  // is called with a schema). Pinned to Anthropic — cross-provider
  // fallback is risky for a complex tool-input schema.
  intake_full_parse: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic'],
  },
};

export function lookupRoute(task: string, custom?: Record<string, RouteConfig>): RouteConfig {
  return custom?.[task] ?? ROUTING[task as KnownTask] ?? DEFAULT_ROUTE;
}
