import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import {
  deleteSession,
  getDecision,
  getSession,
  listCruxes,
  listMessages,
  listPositions,
} from '@/server/ops-services/board';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, { requiredScope: 'read:board' });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const url = new URL(req.url);

  try {
    const session = await getSession(id);
    if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const [messages, cruxes, positions, decision] = await Promise.all([
      listMessages(id),
      listCruxes(id),
      listPositions(id),
      getDecision(id),
    ]);

    await logAuditSuccess(
      auth.key.id,
      'GET',
      url.pathname + url.search,
      200,
      auth.key.ip,
      req.headers.get('user-agent'),
      auth.bodySha,
      auth.reason,
    );
    return NextResponse.json({ session, messages, cruxes, positions, decision });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }
}

/**
 * Hard-delete a session and its children (transcript / cruxes / positions /
 * proposed decision cascade via FK ON DELETE CASCADE). Refuses to delete
 * accepted/edited sessions because that would orphan the spawned
 * ops.decisions row and kanban cards.
 */
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, { requiredScope: 'write:board', destructive: true });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const url = new URL(req.url);

  try {
    const session = await getSession(id);
    if (!session) return NextResponse.json({ error: 'not found' }, { status: 404 });
    if (session.status === 'accepted' || session.status === 'edited') {
      return NextResponse.json(
        { error: `cannot delete session in ${session.status} state` },
        { status: 409 },
      );
    }
    const ok = await deleteSession(id);
    if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }

  await logAuditSuccess(
    auth.key.id,
    'DELETE',
    url.pathname + url.search,
    200,
    auth.key.ip,
    req.headers.get('user-agent'),
    auth.bodySha,
    auth.reason,
  );
  return NextResponse.json({ ok: true });
}
