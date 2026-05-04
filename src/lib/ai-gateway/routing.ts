/**
 * Per-task routing config. Edited by hand — no UI for now. Adding a new
 * task means appending to `tasks.ts` and a row here; unknown tasks fall
 * through to `DEFAULT_ROUTE`.
 *
 * Strategic notes:
 *  - `secondary` weights are the *intentional tier-climb traffic* — we
 *    over-route a slice to OpenAI / Anthropic so HeyHenry's spend keeps
 *    flowing into those tier ladders. AG-6 will tune these dynamically
 *    once it can see actual spend vs ladder thresholds.
 *  - `fallback_chain` order matters: cheapest first usually, but for
 *    quality-sensitive tasks (e.g. project_memo) we order by capability.
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

  // Project memos are multimodal (audio + photos). Pre-AG-7 the direct
  // caller used Gemini exclusively; we keep Gemini primary to avoid a
  // behavior change at migration time. Re-evaluate quality vs cost
  // against Anthropic after a week of telemetry.
  project_memo_generate: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'anthropic', 'openai'],
  },

  // High-volume but throwaway (one classification per inbound email).
  // Gemini Flash is plenty.
  email_classify: {
    primary: { provider: 'gemini' },
    fallback_chain: ['gemini', 'openai'],
  },

  // Originally OpenAI in the legacy coa-mapping flow. Kept on OpenAI
  // primary for now to avoid a behavior change at migration time;
  // AG-7 can re-evaluate after a week of telemetry.
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
    // Originally Anthropic (claude-opus). Behavior preserved at migration:
    // route to Anthropic primary, Gemini fallback.
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic', 'gemini'],
  },

  // AG-7b — keep each on its original provider to avoid behavior regressions
  // at migration. Re-evaluate after a week of telemetry.

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

  // AG-9 — intake.ts paths.
  // Audio transcription is OpenAI-only (Whisper / gpt-4o-transcribe).
  // Gemini and Anthropic don't expose a dedicated transcription
  // primitive — both throw `invalid_input` if routed here. No fallback.
  audio_transcribe_intake: {
    primary: { provider: 'openai' },
    fallback_chain: ['openai'],
  },
  // Full intake parse uses Anthropic tool-use under the hood (handled
  // by the Anthropic adapter automatically when `runStructured` is
  // called with a schema). Pin to Anthropic primary; cross-provider
  // fallback is risky for a complex tool-input schema.
  intake_full_parse: {
    primary: { provider: 'anthropic' },
    fallback_chain: ['anthropic'],
  },
};

export function lookupRoute(task: string, custom?: Record<string, RouteConfig>): RouteConfig {
  return custom?.[task] ?? ROUTING[task as KnownTask] ?? DEFAULT_ROUTE;
}
