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
    primary: { provider: 'gemini' },
    secondary: { provider: 'anthropic', weight: 0.25 },
    fallback_chain: ['gemini', 'anthropic'],
  },
};

export function lookupRoute(task: string, custom?: Record<string, RouteConfig>): RouteConfig {
  return custom?.[task] ?? ROUTING[task as KnownTask] ?? DEFAULT_ROUTE;
}
