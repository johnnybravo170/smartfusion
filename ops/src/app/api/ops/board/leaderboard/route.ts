import { type NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, logAuditSuccess } from '@/lib/api-auth';
import { listAdvisorStats, listAdvisors } from '@/server/ops-services/board';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req, { requiredScope: 'read:board' });
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);

  try {
    const [stats, advisors] = await Promise.all([listAdvisorStats(), listAdvisors()]);
    const advisorById = new Map(advisors.map((a) => [a.id, a]));
    const rows = stats
      .map((s) => {
        const a = advisorById.get(s.advisor_id);
        if (!a) return null;
        return {
          advisor_id: s.advisor_id,
          slug: a.slug,
          name: a.name,
          emoji: a.emoji,
          title: a.title,
          role_kind: s.role_kind,
          status: s.status,
          sessions: s.sessions,
          positions_taken: s.positions_taken,
          credited: s.credited,
          overruled: s.overruled,
          concessions: s.concessions,
          credit_rate:
            s.positions_taken > 0 ? Math.round((s.credited / s.positions_taken) * 100) : null,
          overrule_rate:
            s.positions_taken > 0 ? Math.round((s.overruled / s.positions_taken) * 100) : null,
          avg_human_rating:
            s.avg_human_rating !== null && s.avg_human_rating !== undefined
              ? Number(Number(s.avg_human_rating).toFixed(2))
              : null,
          proven_right_credit: s.proven_right_credit,
          proven_wrong_credit: s.proven_wrong_credit,
          overruled_but_right: s.overruled_but_right,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

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
    return NextResponse.json({ leaderboard: rows });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    );
  }
}
