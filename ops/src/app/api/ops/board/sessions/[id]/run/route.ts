import { waitUntil } from '@vercel/functions';
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
 *
 * Fire-and-forget reliability: bare `void runDiscussion(...)` lets Vercel
 * kill the function as soon as the response is sent. `waitUntil(...)` is
 * the platform contract that says "keep me alive while this promise is
 * pending." Combined with maxDuration=800 (Pro tier max), board sessions
 * up to ~13 minutes wall-clock can complete reliably.
 */
export const maxDuration = 800;

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

  // waitUntil keeps the Vercel function alive until runDiscussion settles
  // (success or failure). Without this, Vercel may kill the function as
  // soon as the response is sent, leaving the session stuck in 'running'
  // with no error_message. The .catch is for log surfacing only — the
  // engine persists failures to the session row itself.
  waitUntil(
    runDiscussion(id).catch((err) => {
      console.error(`[board.run] ${id} failed:`, err);
    }),
  );

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
