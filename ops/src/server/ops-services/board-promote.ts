/**
 * Board → ops.decisions + ops.kanban_cards "action sinks".
 *
 * Fires only on explicit human (or HMAC agent) acceptance of a board
 * decision. Idempotency comes from the status transition: a decision can
 * only go from 'proposed' to 'accepted'/'edited' once. Re-accept attempts
 * fail upstream before reaching here.
 *
 * Writes happen in a single supabase round-trip per table; we don't wrap
 * them in a transaction because cross-statement transactions aren't
 * directly available through @supabase/supabase-js. If one fails after
 * the other succeeded the user sees the partial state via board_decisions.links
 * and can manually clean up — rare given how scoped this is.
 */

import type { ActionItem, BoardDecision } from '@/lib/board/types';
import { createServiceClient } from '@/lib/supabase';
import { getDecision, getSession, updateDecision } from './board';

export type PromoteResult = {
  decision_id: string;
  kanban_card_ids: string[];
  /** Boards the cards landed in, by slug. */
  kanban_boards: string[];
};

const DEFAULT_BOARD_SLUG = 'ops';
const VALID_BOARD_SLUGS = new Set(['ops', 'dev', 'marketing', 'research']);

/**
 * Promote a proposed decision to canonical ops.* tables.
 *
 * Pre-condition: caller has just transitioned board_decisions.status from
 * 'proposed' to 'accepted' or 'edited' (or is doing so as part of accept).
 * If decision.promoted_at is already set we no-op and return existing links.
 */
export async function promoteDecisionToOpsTables(
  session_id: string,
  actor: { admin_user_id?: string | null; key_id?: string | null; actor_name: string },
): Promise<PromoteResult> {
  const session = await getSession(session_id);
  if (!session) throw new Error('session not found');
  const decision = await getDecision(session_id);
  if (!decision) throw new Error('no decision on session — cannot promote');

  // Idempotent: if already promoted, return the existing links.
  if (decision.promoted_at && isPromoteResult(decision.links)) {
    return decision.links;
  }
  if (decision.status === 'rejected') {
    throw new Error('decision is rejected; cannot promote');
  }

  const effectiveText = decision.edited_decision_text ?? decision.decision_text;
  const effectiveActionItems = decision.edited_action_items ?? decision.action_items;

  const svc = createServiceClient();
  const fromBoardTag = `from-board:${session_id}`;
  const actorBase = {
    actor_type: actor.admin_user_id ? ('human' as const) : ('agent' as const),
    actor_name: actor.actor_name,
    admin_user_id: actor.admin_user_id ?? null,
    key_id: actor.key_id ?? null,
  };

  // ── 1. ops.decisions ─────────────────────────────────────────────────
  const decisionRow = {
    ...actorBase,
    title: truncate(session.title, 200),
    hypothesis: composeHypothesis(decision, effectiveText),
    action: composeAction(decision, effectiveActionItems),
    status: 'open' as const,
    tags: [fromBoardTag, `board-decision:${decision.id}`],
  };
  const { data: opsDec, error: decErr } = await svc
    .schema('ops')
    .from('decisions')
    .insert(decisionRow)
    .select('id')
    .single();
  if (decErr || !opsDec)
    throw new Error(`promote: ops.decisions insert failed: ${decErr?.message}`);
  const opsDecisionId = opsDec.id as string;

  // ── 2. ops.kanban_cards (one per action item) ───────────────────────
  const kanbanCardIds: string[] = [];
  const boardsHit = new Set<string>();

  if (effectiveActionItems.length > 0) {
    // Resolve board slugs → board ids in one round-trip.
    const wantedSlugs = unique(effectiveActionItems.map((a) => normalizeBoardSlug(a.board_slug)));
    const { data: boards, error: bErr } = await svc
      .schema('ops')
      .from('kanban_boards')
      .select('id, slug')
      .in('slug', wantedSlugs);
    if (bErr) throw new Error(`promote: kanban_boards lookup failed: ${bErr.message}`);
    const slugToId = new Map<string, string>();
    for (const b of boards ?? []) slugToId.set(b.slug as string, b.id as string);

    const cardRows = effectiveActionItems
      .map((item, idx) => {
        const slug = normalizeBoardSlug(item.board_slug);
        const board_id = slugToId.get(slug);
        if (!board_id) return null;
        boardsHit.add(slug);
        return {
          ...actorBase,
          board_id,
          column_key: 'todo' as const,
          title: truncate(item.text, 200),
          body: item.text.length > 200 ? item.text : null,
          tags: unique([fromBoardTag, `board-decision:${decision.id}`, ...(item.tags ?? [])]),
          order_in_column: idx,
          related_type: 'board_decision' as const,
          related_id: decision.id,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (cardRows.length > 0) {
      const { data: cards, error: cErr } = await svc
        .schema('ops')
        .from('kanban_cards')
        .insert(cardRows)
        .select('id');
      if (cErr) throw new Error(`promote: kanban insert failed: ${cErr.message}`);
      for (const c of cards ?? []) kanbanCardIds.push(c.id as string);
    }
  }

  const links: PromoteResult = {
    decision_id: opsDecisionId,
    kanban_card_ids: kanbanCardIds,
    kanban_boards: [...boardsHit],
  };

  // ── 3. Mark the board_decisions row as promoted ─────────────────────
  await updateDecision(decision.id, {
    promoted_at: new Date().toISOString(),
    links: links as unknown as Record<string, unknown>,
  });

  return links;
}

function isPromoteResult(x: unknown): x is PromoteResult {
  if (!x || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  return typeof obj.decision_id === 'string' && Array.isArray(obj.kanban_card_ids);
}

function normalizeBoardSlug(slug: string | undefined): string {
  if (!slug) return DEFAULT_BOARD_SLUG;
  const lower = slug.toLowerCase().trim();
  return VALID_BOARD_SLUGS.has(lower) ? lower : DEFAULT_BOARD_SLUG;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * ops.decisions.hypothesis is the "why this decision" body. Pull the
 * board's reasoning and feedback-loop check together so the
 * canonical decisions row carries the full context.
 */
function composeHypothesis(decision: BoardDecision, effectiveText: string): string {
  const parts = [
    `**Decision:** ${effectiveText}`,
    '',
    '**Reasoning:**',
    decision.reasoning,
    '',
    '**Feedback-loop check:**',
    decision.feedback_loop_check,
  ];
  if (decision.dissenting_views) {
    parts.push('', '**Dissenting views:**', decision.dissenting_views);
  }
  if (decision.chair_overrode_majority && decision.chair_disagreement_note) {
    parts.push('', '**Chair overrode the panel:**', decision.chair_disagreement_note);
  }
  return parts.join('\n');
}

function composeAction(_decision: BoardDecision, items: ActionItem[]): string | null {
  if (items.length === 0) return null;
  return [
    'Action items spawned to kanban:',
    ...items.map((it, i) => `${i + 1}. ${it.text}${it.board_slug ? ` [→ ${it.board_slug}]` : ''}`),
  ].join('\n');
}
