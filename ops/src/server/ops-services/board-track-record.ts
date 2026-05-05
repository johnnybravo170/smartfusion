/**
 * Self-tuning loop. Renders an advisor's (or chair's) track record into a
 * prompt block that gets injected into their system prompt at session
 * start. The advisor literally sees their own report card next session
 * and can adjust.
 *
 * Two flavors:
 *   - Expert/challenger advisors: per-advisor numerics + verbatim
 *     low-rated and high-rated review notes.
 *   - Chair: aggregated patterns across all sessions — recent accepted
 *     decisions, recent rejected decisions (with reasons), and outcome
 *     attribution where marked.
 *
 * "Themes" via NLP is deferred. For now: numbers + verbatim notes is
 * already strong enough signal for the model to adjust on.
 */

import { createServiceClient } from '@/lib/supabase';
import { getAdvisorStat, listRatedMessagesForAdvisor } from './board';

const RECENT_RATED_LIMIT = 4;

export async function renderAdvisorTrackRecord(advisor_id: string): Promise<string | null> {
  const stat = await getAdvisorStat(advisor_id);
  if (!stat || stat.sessions === 0) return null;

  const lines: string[] = [
    `## Your record so far`,
    `Across ${stat.sessions} session${stat.sessions === 1 ? '' : 's'}: positions taken ${stat.positions_taken}, credited by chair ${stat.credited}, overruled by chair ${stat.overruled}, conceded mid-debate ${stat.concessions}.`,
  ];

  if (
    stat.proven_right_credit > 0 ||
    stat.proven_wrong_credit > 0 ||
    stat.overruled_but_right > 0
  ) {
    const tally: string[] = [];
    if (stat.proven_right_credit > 0)
      tally.push(`${stat.proven_right_credit} credited on decisions later proven RIGHT`);
    if (stat.proven_wrong_credit > 0)
      tally.push(`${stat.proven_wrong_credit} credited on decisions later proven WRONG`);
    if (stat.overruled_but_right > 0)
      tally.push(`${stat.overruled_but_right} overruled but later turned out you were RIGHT`);
    lines.push(`Outcomes (where marked): ${tally.join('; ')}.`);
  }

  if (stat.avg_human_rating !== null && stat.avg_human_rating !== undefined) {
    lines.push(
      `Avg per-message rating from Jonathan: ${Number(stat.avg_human_rating).toFixed(2)}/5.`,
    );
  }

  if (stat.role_kind === 'challenger') {
    lines.push(
      `Note: you're the Devil's Advocate. High overrule rate is expected. What matters is whether the chair engaged substantively with your challenges or dismissed them.`,
    );
  }

  // Verbatim notes — what to repeat, what to avoid.
  const [low, high] = await Promise.all([
    listRatedMessagesForAdvisor(advisor_id, { limit: RECENT_RATED_LIMIT, maxRating: 2 }),
    listRatedMessagesForAdvisor(advisor_id, { limit: RECENT_RATED_LIMIT, minRating: 4 }),
  ]);

  if (low.length > 0) {
    lines.push('', '### Patterns to AVOID (recent low-rated messages from you)');
    for (const m of low) {
      const note = m.review_note ? ` — note: "${m.review_note}"` : '';
      lines.push(`- "${m.content_preview}" [${m.advisor_rating}/5]${note}`);
    }
  }
  if (high.length > 0) {
    lines.push('', '### Patterns to REPEAT (recent high-rated messages from you)');
    for (const m of high) {
      const note = m.review_note ? ` — note: "${m.review_note}"` : '';
      lines.push(`- "${m.content_preview}" [${m.advisor_rating}/5]${note}`);
    }
  }

  return lines.join('\n');
}

const CHAIR_RECENT_DECISIONS_LIMIT = 8;

/**
 * Chair gets a different shape: recent accepted/rejected decisions across
 * all sessions, plus outcome attribution where marked. Helps the chair
 * recalibrate when its synthesis style was off, or when its overrules
 * have been systematically wrong.
 */
export async function renderChairTrackRecord(): Promise<string | null> {
  const svc = createServiceClient();
  const { data: decisions, error } = await svc
    .schema('ops')
    .from('board_decisions')
    .select(
      'id, decision_text, status, outcome, rejected_reason, chair_overrode_majority, accepted_at, created_at, board_sessions:session_id(title, overall_rating, review_notes)',
    )
    .order('created_at', { ascending: false })
    .limit(40);
  if (error || !decisions || decisions.length === 0) return null;

  type Row = {
    id: string;
    decision_text: string;
    status: 'proposed' | 'accepted' | 'edited' | 'rejected';
    outcome: 'pending' | 'proven_right' | 'proven_wrong' | 'obsolete';
    rejected_reason: string | null;
    chair_overrode_majority: boolean;
    accepted_at: string | null;
    created_at: string;
    board_sessions:
      | { title: string; overall_rating: number | null; review_notes: string | null }
      | { title: string; overall_rating: number | null; review_notes: string | null }[]
      | null;
  };
  const rows = (decisions as Row[]).map((d) => ({
    ...d,
    session: Array.isArray(d.board_sessions) ? d.board_sessions[0] : d.board_sessions,
  }));

  const accepted = rows
    .filter((d) => d.status === 'accepted' || d.status === 'edited')
    .slice(0, CHAIR_RECENT_DECISIONS_LIMIT);
  const rejected = rows
    .filter((d) => d.status === 'rejected')
    .slice(0, CHAIR_RECENT_DECISIONS_LIMIT);
  const provenRight = rows.filter((d) => d.outcome === 'proven_right');
  const provenWrong = rows.filter((d) => d.outcome === 'proven_wrong');

  if (accepted.length === 0 && rejected.length === 0) return null;

  const lines: string[] = ['## Your record as Chair'];

  if (accepted.length > 0) {
    lines.push('', '### Recent accepted decisions');
    for (const d of accepted) {
      const rating = d.session?.overall_rating ? ` [${d.session.overall_rating}/5]` : '';
      const overrode = d.chair_overrode_majority ? ' (you overrode the panel)' : '';
      lines.push(`- "${truncate(d.decision_text, 200)}"${rating}${overrode}`);
      if (d.session?.review_notes)
        lines.push(`  Jonathan's notes: ${truncate(d.session.review_notes, 300)}`);
    }
  }

  if (rejected.length > 0) {
    lines.push('', '### Recent rejected decisions (study these)');
    for (const d of rejected) {
      lines.push(`- "${truncate(d.decision_text, 200)}"`);
      if (d.rejected_reason) lines.push(`  Reason: ${truncate(d.rejected_reason, 300)}`);
    }
  }

  if (provenRight.length > 0 || provenWrong.length > 0) {
    lines.push('', '### Outcomes (where marked retroactively)');
    if (provenRight.length > 0) {
      lines.push(`Proven RIGHT (${provenRight.length}):`);
      for (const d of provenRight.slice(0, 5))
        lines.push(`  ✓ "${truncate(d.decision_text, 160)}"`);
    }
    if (provenWrong.length > 0) {
      lines.push(`Proven WRONG (${provenWrong.length}) — examine the pattern:`);
      for (const d of provenWrong.slice(0, 5))
        lines.push(`  ✗ "${truncate(d.decision_text, 160)}"`);
    }
  }

  return lines.join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
