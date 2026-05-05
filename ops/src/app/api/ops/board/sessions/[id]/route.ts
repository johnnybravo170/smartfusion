import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import {
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
