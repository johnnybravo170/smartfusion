import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { actionItemSchema } from '@/lib/board/types';
import { getDecision, updateDecision, updateSession } from '@/server/ops-services/board';
import { promoteDecisionToOpsTables } from '@/server/ops-services/board-promote';

const acceptSchema = z.object({
  /** Optional in-place edit. When present, decision goes to status='edited'
   *  and the edited content is what fires sinks. Omitted = plain accept. */
  edited_decision_text: z.string().trim().min(1).max(2000).optional(),
  edited_action_items: z.array(actionItemSchema).max(10).optional(),
  /** Required for audit. Agents passing through must say who they are. */
  actor_name: z.string().trim().min(1).max(200),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:board:review' });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = acceptSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const decision = await getDecision(id);
  if (!decision) return NextResponse.json({ error: 'no decision' }, { status: 404 });
  if (decision.status !== 'proposed') {
    return NextResponse.json(
      { error: `decision is ${decision.status}; already finalized` },
      { status: 409 },
    );
  }

  const isEdited =
    parsed.data.edited_decision_text !== undefined || parsed.data.edited_action_items !== undefined;
  const targetStatus = isEdited ? 'edited' : 'accepted';
  const now = new Date().toISOString();

  try {
    if (isEdited) {
      await updateDecision(decision.id, {
        edited_decision_text:
          parsed.data.edited_decision_text ?? decision.edited_decision_text ?? null,
        edited_action_items:
          parsed.data.edited_action_items ?? decision.edited_action_items ?? null,
      });
    }
    await updateDecision(decision.id, { status: targetStatus, accepted_at: now });

    const result = await promoteDecisionToOpsTables(id, {
      key_id: auth.key.id,
      actor_name: parsed.data.actor_name,
    });
    await updateSession(id, { status: targetStatus, reviewed_at: now });

    const url = new URL(req.url);
    await logAuditSuccess(
      auth.key.id,
      'POST',
      url.pathname + url.search,
      200,
      auth.key.ip,
      req.headers.get('user-agent'),
      auth.bodySha,
      auth.reason,
    );
    return NextResponse.json({
      ok: true,
      status: targetStatus,
      ops_decision_id: result.decision_id,
      kanban_card_ids: result.kanban_card_ids,
      kanban_boards: result.kanban_boards,
    });
  } catch (err) {
    // Roll back so caller can retry.
    await updateDecision(decision.id, { status: 'proposed', accepted_at: null });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }
}
