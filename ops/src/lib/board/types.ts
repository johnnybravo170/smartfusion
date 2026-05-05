/**
 * Board domain types + zod schemas. These describe rows we read/write to
 * ops.* and the structured payloads the engine asks the LLM to produce.
 *
 * The engine asks for JSON in several places (chair crux extraction, chair
 * turn action, advisor final position). Zod here is the trust boundary: if
 * the model returns garbage, the engine treats it as a model failure and
 * either retries or falls through to a safer code path.
 */

import { z } from 'zod';

// ---- Advisors --------------------------------------------------------

export const advisorRoleKindSchema = z.enum(['expert', 'challenger', 'chair']);
export const advisorStatusSchema = z.enum(['active', 'retired']);

export const advisorSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  emoji: z.string(),
  title: z.string(),
  role_kind: advisorRoleKindSchema,
  expertise: z.array(z.string()),
  description: z.string(),
  knowledge_id: z.string().uuid().nullable(),
  status: advisorStatusSchema,
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Advisor = z.infer<typeof advisorSchema>;

export const advisorWithKnowledgeSchema = advisorSchema.extend({
  knowledge_body: z.string().nullable(),
});
export type AdvisorWithKnowledge = z.infer<typeof advisorWithKnowledgeSchema>;

// ---- Sessions --------------------------------------------------------

export const sessionStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_review',
  'accepted',
  'edited',
  'rejected',
  'revised',
  'failed',
]);

export const sessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  topic: z.string(),
  status: sessionStatusSchema,
  advisor_ids: z.array(z.string().uuid()),
  provider_override: z.string().nullable(),
  model_override: z.string().nullable(),
  budget_cents: z.number(),
  spent_cents: z.number(),
  call_count: z.number().int(),
  context_snapshot: z.unknown().nullable(),
  error_message: z.string().nullable(),
  created_by_admin_user_id: z.string().uuid().nullable(),
  created_by_key_id: z.string().uuid().nullable(),
  created_at: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  overall_rating: z.number().int().min(1).max(5).nullable(),
  review_notes: z.string().nullable(),
});
export type BoardSession = z.infer<typeof sessionSchema>;

export const createSessionInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  topic: z.string().trim().min(1).max(20_000),
  advisor_ids: z.array(z.string().uuid()).min(2).max(15),
  provider_override: z.enum(['anthropic', 'openrouter']).optional().nullable(),
  model_override: z.string().trim().min(1).max(200).optional().nullable(),
  budget_cents: z.number().int().min(50).max(5000).optional(), // $0.50–$50
});
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;

// ---- Cruxes ----------------------------------------------------------

export const cruxStatusSchema = z.enum(['open', 'resolved', 'deadlock', 'dropped']);

export const cruxSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  label: z.string(),
  status: cruxStatusSchema,
  resolution_summary: z.string().nullable(),
  sort_order: z.number().int(),
  opened_at: z.string(),
  closed_at: z.string().nullable(),
});
export type Crux = z.infer<typeof cruxSchema>;

// ---- Messages --------------------------------------------------------

export const turnKindSchema = z.enum([
  'opening',
  'exchange',
  'challenge',
  'poll',
  'chair_turn',
  'final_position',
  'synthesis',
  'system',
]);

export const messageSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  advisor_id: z.string().uuid().nullable(),
  crux_id: z.string().uuid().nullable(),
  turn_kind: turnKindSchema,
  addressed_to: z.string().uuid().nullable(),
  content: z.string(),
  payload: z.unknown().nullable(),
  new_information: z.boolean().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  prompt_tokens: z.number().int().nullable(),
  completion_tokens: z.number().int().nullable(),
  cost_cents: z.number().nullable(),
  latency_ms: z.number().int().nullable(),
  advisor_rating: z.number().int().min(1).max(5).nullable(),
  review_note: z.string().nullable(),
  created_at: z.string(),
});
export type BoardMessage = z.infer<typeof messageSchema>;

// ---- Positions -------------------------------------------------------

export const positionSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  advisor_id: z.string().uuid(),
  crux_id: z.string().uuid().nullable(),
  stance: z.string(),
  confidence: z.number().int().min(1).max(5),
  rationale: z.string(),
  shifted_from_opening: z.boolean(),
  emitted_at: z.string(),
});
export type BoardPosition = z.infer<typeof positionSchema>;

// ---- Decisions -------------------------------------------------------

export const decisionStatusSchema = z.enum(['proposed', 'accepted', 'edited', 'rejected']);
export const decisionOutcomeSchema = z.enum([
  'pending',
  'proven_right',
  'proven_wrong',
  'obsolete',
]);

export const actionItemSchema = z.object({
  text: z.string(),
  /** Optional kanban hints. Used at accept-time when sinks fire. */
  board_slug: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type ActionItem = z.infer<typeof actionItemSchema>;

export const decisionSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  decision_text: z.string(),
  reasoning: z.string(),
  feedback_loop_check: z.string(),
  action_items: z.array(actionItemSchema),
  dissenting_views: z.string().nullable(),
  chair_overrode_majority: z.boolean(),
  chair_disagreement_note: z.string().nullable(),
  credited_advisor_ids: z.array(z.string().uuid()),
  overruled_advisor_ids: z.array(z.string().uuid()),
  overrule_reasons: z.record(z.string(), z.string()),
  status: decisionStatusSchema,
  edited_decision_text: z.string().nullable(),
  edited_action_items: z.array(actionItemSchema).nullable(),
  rejected_reason: z.string().nullable(),
  outcome: decisionOutcomeSchema,
  outcome_marked_at: z.string().nullable(),
  outcome_notes: z.string().nullable(),
  created_at: z.string(),
  accepted_at: z.string().nullable(),
  promoted_at: z.string().nullable(),
  links: z.record(z.string(), z.unknown()),
});
export type BoardDecision = z.infer<typeof decisionSchema>;

// ---- Engine I/O schemas (what we ask the LLM to produce) -------------

/** Phase B: chair extracts cruxes from opening statements. */
export const cruxExtractionSchema = z.object({
  consensus: z.array(z.string()).max(20),
  cruxes: z
    .array(
      z.object({
        label: z.string().min(1).max(200),
        /** Advisors centrally involved in this disagreement (slugs). */
        advisors: z.array(z.string()).min(1).max(10),
        /** Optional one-line of what's actually in dispute. */
        summary: z.string().max(400).optional(),
      }),
    )
    .min(0)
    .max(8),
});
export type CruxExtraction = z.infer<typeof cruxExtractionSchema>;

/** Phase C: chair picks the next move. */
export const chairActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('exchange'),
    crux_id: z.string().uuid(),
    advisor_a: z.string().uuid(),
    advisor_b: z.string().uuid(),
    prompt: z.string().min(10).max(2000),
    reasoning: z.string().min(1).max(1000),
    new_information: z.boolean(),
  }),
  z.object({
    action: z.literal('challenge'),
    crux_id: z.string().uuid(),
    challenger_id: z.string().uuid(),
    target_id: z.string().uuid(),
    prompt: z.string().min(10).max(2000),
    reasoning: z.string().min(1).max(1000),
    new_information: z.boolean(),
  }),
  z.object({
    action: z.literal('poll'),
    crux_id: z.string().uuid(),
    question: z.string().min(5).max(500),
    reasoning: z.string().min(1).max(1000),
    new_information: z.boolean(),
  }),
  z.object({
    action: z.literal('next_crux'),
    crux_id: z.string().uuid(),
    crux_status: z.enum(['resolved', 'deadlock', 'dropped']),
    resolution_summary: z.string().min(1).max(2000),
    new_information: z.boolean(),
  }),
  z.object({
    action: z.literal('close'),
    reasoning: z.string().min(1).max(1000),
  }),
]);
export type ChairAction = z.infer<typeof chairActionSchema>;

/** Phase D: each advisor's structured final position. */
export const finalPositionSchema = z.object({
  overall: z.object({
    stance: z.string().min(1).max(500),
    confidence: z.number().int().min(1).max(5),
    rationale: z.string().min(1).max(3000),
  }),
  cruxes: z
    .array(
      z.object({
        crux_id: z.string().uuid(),
        stance: z.string().min(1).max(500),
        confidence: z.number().int().min(1).max(5),
        rationale: z.string().min(1).max(2000),
      }),
    )
    .max(20),
  shifted_from_opening: z.array(z.string().uuid()).max(20),
});
export type FinalPosition = z.infer<typeof finalPositionSchema>;

/** Phase D: chair synthesis. Trailing JSON tail captures credits. */
export const chairSynthesisSchema = z.object({
  decision_text: z.string().min(1).max(2000),
  reasoning: z.string().min(1).max(5000),
  feedback_loop_check: z.string().min(1).max(2000),
  action_items: z.array(actionItemSchema).max(10),
  dissenting_views: z.string().max(3000).optional().nullable(),
  chair_overrode_majority: z.boolean(),
  chair_disagreement_note: z.string().max(3000).optional().nullable(),
  credited_advisor_ids: z.array(z.string().uuid()).max(20),
  overruled_advisor_ids: z.array(z.string().uuid()).max(20),
  overrule_reasons: z.record(z.string(), z.string()),
});
export type ChairSynthesis = z.infer<typeof chairSynthesisSchema>;
