'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { actionItemSchema, createSessionInputSchema } from '@/lib/board/types';
import { requireAdmin } from '@/lib/ops-gate';
import {
  createSession,
  deleteSession,
  getDecision,
  getDecisionById,
  getSession,
  rateMessage,
  updateDecision,
  updateSession,
} from '@/server/ops-services/board';
import { runDiscussion } from '@/server/ops-services/board-discussion';
import { promoteDecisionToOpsTables } from '@/server/ops-services/board-promote';

type ActionResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ── Convene + run ────────────────────────────────────────────────────

export async function createBoardSessionAction(input: {
  title: string;
  topic: string;
  advisor_ids: string[];
  provider_override?: 'anthropic' | 'openrouter' | null;
  model_override?: string | null;
  budget_cents?: number;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const parsed = createSessionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  try {
    const s = await createSession(parsed.data, { admin_user_id: admin.userId, key_id: null });
    revalidatePath('/board');
    return { ok: true, id: s.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

export async function runBoardSessionAction(session_id: string): Promise<ActionResult> {
  await requireAdmin();
  const s = await getSession(session_id);
  if (!s) return { ok: false, error: 'session not found' };
  if (s.status !== 'pending')
    return { ok: false, error: `session is ${s.status}; must be pending` };

  void runDiscussion(session_id).catch((err) => {
    console.error(`[board.run] ${session_id} failed:`, err);
  });
  revalidatePath(`/board/sessions/${session_id}`);
  revalidatePath('/board');
  return { ok: true };
}

// ── Rating ───────────────────────────────────────────────────────────

const rateSessionSchema = z.object({
  session_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5).nullable(),
  notes: z.string().trim().max(20_000).nullable(),
});

export async function rateSessionAction(
  input: z.input<typeof rateSessionSchema>,
): Promise<ActionResult> {
  await requireAdmin();
  const parsed = rateSessionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };
  try {
    const updated = await updateSession(parsed.data.session_id, {
      overall_rating: parsed.data.rating,
      review_notes: parsed.data.notes,
      reviewed_at: new Date().toISOString(),
    });
    if (!updated) return { ok: false, error: 'session not found' };
    revalidatePath(`/board/sessions/${parsed.data.session_id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

const rateMessageSchema = z.object({
  message_id: z.string().uuid(),
  rating: z.number().int().min(1).max(5).nullable(),
  note: z.string().trim().max(2000).nullable(),
});

export async function rateMessageAction(
  input: z.input<typeof rateMessageSchema>,
): Promise<ActionResult> {
  await requireAdmin();
  const parsed = rateMessageSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };
  try {
    const m = await rateMessage(parsed.data.message_id, {
      advisor_rating: parsed.data.rating,
      review_note: parsed.data.note,
    });
    if (!m) return { ok: false, error: 'message not found' };
    revalidatePath(`/board/sessions/${m.session_id}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

// ── Decision actions ─────────────────────────────────────────────────

export async function acceptDecisionAction(
  session_id: string,
): Promise<ActionResult<{ ops_decision_id: string; kanban_card_count: number }>> {
  const admin = await requireAdmin();
  return await applyDecisionTransition(session_id, {
    target_status: 'accepted',
    actor_name: admin.email,
    admin_user_id: admin.userId,
  });
}

const editAndAcceptSchema = z.object({
  session_id: z.string().uuid(),
  edited_decision_text: z.string().trim().min(1).max(2000),
  edited_action_items: z.array(actionItemSchema).max(10),
});

export async function editAndAcceptDecisionAction(
  input: z.input<typeof editAndAcceptSchema>,
): Promise<ActionResult<{ ops_decision_id: string; kanban_card_count: number }>> {
  const admin = await requireAdmin();
  const parsed = editAndAcceptSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };

  try {
    const decision = await getDecision(parsed.data.session_id);
    if (!decision) return { ok: false, error: 'no decision' };
    if (decision.status !== 'proposed') {
      return { ok: false, error: `decision is ${decision.status}; cannot edit-and-accept` };
    }
    await updateDecision(decision.id, {
      edited_decision_text: parsed.data.edited_decision_text,
      edited_action_items: parsed.data.edited_action_items,
    });
    return await applyDecisionTransition(parsed.data.session_id, {
      target_status: 'edited',
      actor_name: admin.email,
      admin_user_id: admin.userId,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

const rejectSchema = z.object({
  session_id: z.string().uuid(),
  reason: z.string().trim().min(1).max(2000),
});

export async function rejectDecisionAction(
  input: z.input<typeof rejectSchema>,
): Promise<ActionResult> {
  await requireAdmin();
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };

  try {
    const decision = await getDecision(parsed.data.session_id);
    if (!decision) return { ok: false, error: 'no decision' };
    if (decision.status !== 'proposed') {
      return { ok: false, error: `decision is ${decision.status}; cannot reject` };
    }
    await updateDecision(decision.id, {
      status: 'rejected',
      rejected_reason: parsed.data.reason,
    });
    await updateSession(parsed.data.session_id, {
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
    });
    revalidatePath(`/board/sessions/${parsed.data.session_id}`);
    revalidatePath('/board');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

const rerunSchema = z.object({
  source_session_id: z.string().uuid(),
  revised_topic: z.string().trim().min(1).max(20_000),
});

export async function rerunSessionAction(
  input: z.input<typeof rerunSchema>,
): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const parsed = rerunSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };
  try {
    const source = await getSession(parsed.data.source_session_id);
    if (!source) return { ok: false, error: 'source not found' };

    const fresh = await createSession(
      {
        title: source.title.startsWith('[rev] ') ? source.title : `[rev] ${source.title}`,
        topic: parsed.data.revised_topic,
        advisor_ids: source.advisor_ids,
        provider_override: source.provider_override as
          | 'anthropic'
          | 'openrouter'
          | null
          | undefined,
        model_override: source.model_override,
        budget_cents: source.budget_cents,
      },
      { admin_user_id: admin.userId, key_id: null },
    );
    await updateSession(source.id, {
      status: 'revised',
      reviewed_at: new Date().toISOString(),
    });
    revalidatePath('/board');
    revalidatePath(`/board/sessions/${source.id}`);
    return { ok: true, id: fresh.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

// ── Outcome marking (slice 5) ────────────────────────────────────────

const markOutcomeSchema = z.object({
  decision_id: z.string().uuid(),
  outcome: z.enum(['pending', 'proven_right', 'proven_wrong', 'obsolete']),
  notes: z.string().trim().max(4000).nullable(),
});

/**
 * Retroactively mark whether a decision turned out right, wrong, or
 * obsolete. Drives the long-horizon proven_right_credit /
 * proven_wrong_credit / overruled_but_right columns in the advisor_stats
 * view, and feeds into the Chair's track-record block on next session.
 *
 * Setting outcome='pending' clears a previous mark. Notes are optional
 * but high-signal — they're what the Chair sees ("this turned out wrong
 * because…").
 *
 * Allowed only on accepted/edited decisions. Rejected and proposed
 * decisions never had real-world consequences to evaluate.
 */
export async function markDecisionOutcomeAction(
  input: z.input<typeof markOutcomeSchema>,
): Promise<ActionResult> {
  await requireAdmin();
  const parsed = markOutcomeSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'invalid input' };

  try {
    const decision = await getDecisionById(parsed.data.decision_id);
    if (!decision) return { ok: false, error: 'decision not found' };
    if (decision.status !== 'accepted' && decision.status !== 'edited') {
      return {
        ok: false,
        error: `cannot mark outcome on a ${decision.status} decision`,
      };
    }

    await updateDecision(decision.id, {
      outcome: parsed.data.outcome,
      outcome_marked_at: parsed.data.outcome === 'pending' ? null : new Date().toISOString(),
      outcome_notes: parsed.data.notes,
    });

    revalidatePath('/board/decisions');
    revalidatePath(`/board/sessions/${decision.session_id}`);
    revalidatePath('/board/advisors');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

export async function deleteBoardSessionAction(
  session_id: string,
  redirect_to: string | null = '/board',
): Promise<ActionResult> {
  await requireAdmin();
  try {
    const ok = await deleteSession(session_id);
    if (!ok) return { ok: false, error: 'session not found' };
    revalidatePath('/board');
    if (redirect_to) redirect(redirect_to);
    return { ok: true };
  } catch (err) {
    // redirect() throws an internal NEXT_REDIRECT — let it bubble.
    if (err instanceof Error && err.message === 'NEXT_REDIRECT') throw err;
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

// ── Internal: shared accept/edited transition + sink fire ────────────

async function applyDecisionTransition(
  session_id: string,
  opts: {
    target_status: 'accepted' | 'edited';
    actor_name: string;
    admin_user_id?: string | null;
    key_id?: string | null;
  },
): Promise<ActionResult<{ ops_decision_id: string; kanban_card_count: number }>> {
  const decision = await getDecision(session_id);
  if (!decision) return { ok: false, error: 'no decision on session' };
  if (decision.status !== 'proposed') {
    return { ok: false, error: `decision is ${decision.status}; already finalized` };
  }

  const now = new Date().toISOString();
  await updateDecision(decision.id, {
    status: opts.target_status,
    accepted_at: now,
  });

  let result: Awaited<ReturnType<typeof promoteDecisionToOpsTables>>;
  try {
    result = await promoteDecisionToOpsTables(session_id, {
      admin_user_id: opts.admin_user_id ?? null,
      key_id: opts.key_id ?? null,
      actor_name: opts.actor_name,
    });
  } catch (err) {
    // Roll the status back so the user can retry.
    await updateDecision(decision.id, { status: 'proposed', accepted_at: null });
    return {
      ok: false,
      error: `promote failed: ${err instanceof Error ? err.message : 'unknown'}`,
    };
  }

  await updateSession(session_id, {
    status: opts.target_status,
    reviewed_at: now,
  });

  revalidatePath(`/board/sessions/${session_id}`);
  revalidatePath('/board');
  return {
    ok: true,
    ops_decision_id: result.decision_id,
    kanban_card_count: result.kanban_card_ids.length,
  };
}
