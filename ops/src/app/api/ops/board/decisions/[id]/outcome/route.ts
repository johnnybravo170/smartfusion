import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { getDecisionById, updateDecision } from '@/server/ops-services/board';

const schema = z.object({
  outcome: z.enum(['pending', 'proven_right', 'proven_wrong', 'obsolete']),
  notes: z.string().trim().max(4000).nullable().optional(),
});

/**
 * Retroactively mark whether a decision turned out right, wrong, or
 * obsolete. Drives the long-horizon proven_right_credit /
 * proven_wrong_credit / overruled_but_right columns in advisor_stats.
 *
 * Allowed only on accepted/edited decisions. Setting outcome='pending'
 * clears a previous mark.
 */
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
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const decision = await getDecisionById(id);
  if (!decision) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (decision.status !== 'accepted' && decision.status !== 'edited') {
    return NextResponse.json(
      { error: `cannot mark outcome on a ${decision.status} decision` },
      { status: 409 },
    );
  }

  try {
    await updateDecision(decision.id, {
      outcome: parsed.data.outcome,
      outcome_marked_at: parsed.data.outcome === 'pending' ? null : new Date().toISOString(),
      outcome_notes: parsed.data.notes ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }

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
  return NextResponse.json({ ok: true });
}
