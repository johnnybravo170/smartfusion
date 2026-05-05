import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import {
  getAdvisor,
  getAdvisorStat,
  listDecisionsForAdvisor,
  listRatedMessagesForAdvisor,
  listRecentPositionsForAdvisor,
} from '@/server/ops-services/board';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(req, { requiredScope: 'read:board' });
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  const url = new URL(req.url);

  try {
    const advisor = await getAdvisor(id);
    if (!advisor) return NextResponse.json({ error: 'not found' }, { status: 404 });

    const [stat, positions, ratedMessages, decisions] = await Promise.all([
      getAdvisorStat(id),
      listRecentPositionsForAdvisor(id, 30),
      listRatedMessagesForAdvisor(id, { limit: 30 }),
      listDecisionsForAdvisor(id, { limit: 30 }),
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
    return NextResponse.json({
      advisor,
      stat,
      positions,
      rated_messages: ratedMessages,
      decisions,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }
}
