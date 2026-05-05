import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { getDecision, updateDecision, updateSession } from '@/server/ops-services/board';

const schema = z.object({
  reason: z.string().trim().min(1).max(2000),
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
  const parsed = schema.safeParse(payload);
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

  try {
    await updateDecision(decision.id, {
      status: 'rejected',
      rejected_reason: parsed.data.reason,
    });
    await updateSession(id, { status: 'rejected', reviewed_at: new Date().toISOString() });
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
