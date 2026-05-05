import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { getSession } from '@/server/ops-services/board';
import { runDiscussion } from '@/server/ops-services/board-discussion';

/**
 * Kick off a board discussion. Returns 202 immediately and runs the engine
 * in the background. Caller polls GET /sessions/:id to watch progress.
 *
 * Failure during run lands as session.status='failed' with error_message
 * populated. The API key is recorded as the actor.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:board:run' });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const url = new URL(req.url);

  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (session.status !== 'pending') {
    return NextResponse.json(
      { error: `session is ${session.status}, must be pending` },
      { status: 409 },
    );
  }

  // Fire-and-forget. Awaiting would tie up the request for minutes; the
  // Vercel function timeout would chop it. We `void` the promise on
  // purpose; failures are persisted to the session row.
  void runDiscussion(id).catch((err) => {
    // Already persisted by the engine, but log for Vercel.
    console.error(`[board.run] ${id} failed:`, err);
  });

  await logAuditSuccess(
    auth.key.id,
    'POST',
    url.pathname + url.search,
    202,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );
  return NextResponse.json({ ok: true, session_id: id }, { status: 202 });
}
