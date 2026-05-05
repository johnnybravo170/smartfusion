import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeError, opsRequest } from '../client.js';
import { errorResult, formatDateTime, textResult } from '../types.js';

const actionItemSchema = z.object({
  text: z.string().min(1).max(2000),
  board_slug: z.enum(['ops', 'dev', 'marketing', 'research']).optional(),
  tags: z.array(z.string().max(40)).max(8).optional(),
});

type Advisor = {
  id: string;
  slug: string;
  name: string;
  emoji: string;
  title: string;
  role_kind: 'expert' | 'challenger' | 'chair';
  expertise: string[];
  description: string;
  status: 'active' | 'retired';
};

type Session = {
  id: string;
  title: string;
  topic: string;
  status: string;
  advisor_ids: string[];
  budget_cents: number;
  spent_cents: number;
  call_count: number;
  created_at: string;
  completed_at: string | null;
  overall_rating: number | null;
};

type Crux = { id: string; label: string; status: string; resolution_summary: string | null };
type Message = {
  id: string;
  advisor_id: string | null;
  turn_kind: string;
  content: string;
  created_at: string;
};
type Decision = {
  id: string;
  decision_text: string;
  feedback_loop_check: string;
  status: string;
  outcome: string;
};

export function registerBoardTools(server: McpServer) {
  server.tool(
    'board_advisors_list',
    'List the active Board of Advisors personas. Returns slug, name, role_kind, and expertise. Use this before creating a session so you know which advisor IDs to pass.',
    {
      include_retired: z.boolean().optional().default(false).describe('Include retired advisors'),
    },
    async ({ include_retired }) => {
      try {
        const q = include_retired ? '?include_retired=true' : '';
        const data = await opsRequest<{ advisors: Advisor[] }>(
          'GET',
          `/api/ops/board/advisors${q}`,
        );
        if (data.advisors.length === 0) return textResult('No advisors configured.');
        let out = `${data.advisors.length} advisor(s):\n\n`;
        for (const a of data.advisors) {
          out += `- ${a.emoji} ${a.name} [${a.role_kind}] (${a.slug})\n`;
          out += `  id: ${a.id}\n`;
          out += `  title: ${a.title}\n`;
          out += `  expertise: ${a.expertise.join(', ') || '(none)'}\n`;
          if (a.description) out += `  ${a.description}\n`;
          out += '\n';
        }
        return textResult(out.trim());
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_sessions_list',
    'List recent board sessions. Filter by status to find awaiting-review or running sessions.',
    {
      limit: z.number().int().min(1).max(200).default(20).describe('Max rows'),
    },
    async ({ limit }) => {
      try {
        const data = await opsRequest<{ sessions: Session[] }>(
          'GET',
          `/api/ops/board/sessions?limit=${limit}`,
        );
        if (data.sessions.length === 0) return textResult('No sessions yet.');
        let out = `${data.sessions.length} session(s):\n\n`;
        for (const s of data.sessions) {
          out += `- ${s.title} [${s.status}] (${s.id})\n`;
          out += `  spent: ${(s.spent_cents / 100).toFixed(2)}/${(s.budget_cents / 100).toFixed(2)} USD, ${s.call_count} calls\n`;
          out += `  created: ${formatDateTime(s.created_at)}${s.completed_at ? `, completed: ${formatDateTime(s.completed_at)}` : ''}\n`;
          if (s.overall_rating !== null) out += `  rated: ${s.overall_rating}/5\n`;
          out += '\n';
        }
        return textResult(out.trim());
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_session_create',
    'Convene a new board session on a topic. Pass a topic (the strategic question, can be long), a list of advisor UUIDs (must include the chair), and an optional model override (e.g. provider="openrouter", model="moonshotai/kimi-k2-thinking"). Use board_advisors_list first to get IDs. Does NOT auto-run; call board_session_run after.',
    {
      title: z.string().trim().min(1).max(200).describe('Short title'),
      topic: z
        .string()
        .trim()
        .min(1)
        .max(20000)
        .describe('The strategic question, with full context'),
      advisor_ids: z.array(z.string().uuid()).min(2).max(15).describe('Must include the chair'),
      provider_override: z
        .enum(['anthropic', 'openrouter'])
        .optional()
        .nullable()
        .describe('Override default provider'),
      model_override: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .optional()
        .nullable()
        .describe('Override default model (e.g. moonshotai/kimi-k2-thinking)'),
      budget_cents: z
        .number()
        .int()
        .min(50)
        .max(5000)
        .optional()
        .describe('USD cents cap, default 500 = $5'),
    },
    async (args) => {
      try {
        const data = await opsRequest<{ session: Session }>(
          'POST',
          '/api/ops/board/sessions',
          args,
        );
        return textResult(
          `Created session ${data.session.id}\n  status: ${data.session.status}\n  budget: $${(data.session.budget_cents / 100).toFixed(2)}\n\nNow call board_session_run with session_id=${data.session.id} to start the discussion.`,
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_session_run',
    'Start a pending session. Returns 202 immediately; the engine runs in the background (typically 2-5 minutes). Poll board_session_get to watch progress.',
    {
      session_id: z.string().uuid(),
    },
    async ({ session_id }) => {
      try {
        await opsRequest('POST', `/api/ops/board/sessions/${session_id}/run`, {});
        return textResult(
          `Session ${session_id} kicked off. Poll board_session_get for progress; expect 2-5 minutes.`,
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_session_get',
    'Read full session state: status, transcript, cruxes, positions, and decision (when complete). Use this to poll a running session or to read a completed synthesis.',
    {
      session_id: z.string().uuid(),
      truncate_messages: z
        .boolean()
        .optional()
        .default(true)
        .describe('If true, snip long message bodies (preserve transcript shape, save tokens)'),
    },
    async ({ session_id, truncate_messages }) => {
      try {
        const data = await opsRequest<{
          session: Session;
          messages: Message[];
          cruxes: Crux[];
          decision: Decision | null;
        }>('GET', `/api/ops/board/sessions/${session_id}`);

        const s = data.session;
        let out = `# ${s.title} [${s.status}]\n`;
        out += `Topic: ${s.topic}\n`;
        out += `Spent: $${(s.spent_cents / 100).toFixed(2)} of $${(s.budget_cents / 100).toFixed(2)}, ${s.call_count} calls\n\n`;

        if (data.cruxes.length > 0) {
          out += `## Cruxes (${data.cruxes.length})\n`;
          for (const c of data.cruxes) {
            out += `- [${c.status}] ${c.label}`;
            if (c.resolution_summary) out += ` — ${c.resolution_summary}`;
            out += '\n';
          }
          out += '\n';
        }

        if (data.messages.length > 0) {
          out += `## Transcript (${data.messages.length} messages)\n`;
          for (const m of data.messages) {
            const body =
              truncate_messages && m.content.length > 600
                ? `${m.content.slice(0, 600)}...[truncated]`
                : m.content;
            out += `\n### [${m.turn_kind}] (${formatDateTime(m.created_at)})\n${body}\n`;
          }
          out += '\n';
        }

        if (data.decision) {
          out += `## Decision (${data.decision.status})\n${data.decision.decision_text}\n\n`;
          out += `**Feedback loop:** ${data.decision.feedback_loop_check}\n`;
          out += `Outcome: ${data.decision.outcome}\n`;
        }

        return textResult(out);
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_session_review',
    'Rate the synthesis quality of a board session and leave free-text notes. Notes are training signal — future sessions surface low-rated patterns to the chair and advisors. Pass rating=null to clear.',
    {
      session_id: z.string().uuid(),
      rating: z.number().int().min(1).max(5).nullable(),
      notes: z.string().trim().max(20_000).nullable(),
    },
    async (args) => {
      try {
        await opsRequest('POST', `/api/ops/board/sessions/${args.session_id}/review`, {
          rating: args.rating,
          notes: args.notes,
        });
        return textResult(
          `Reviewed session ${args.session_id.slice(0, 8)}: rating=${args.rating ?? '(cleared)'}.`,
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_decision_accept',
    "Accept a session's proposed decision. Spawns one row in ops.decisions and one kanban card per action item. Optionally pass edited_decision_text and edited_action_items to edit-and-accept (status becomes 'edited' instead of 'accepted'). Idempotent: a session can only be accepted once.",
    {
      session_id: z.string().uuid(),
      actor_name: z
        .string()
        .trim()
        .min(1)
        .max(200)
        .describe("Who's accepting (agent slug or human name)"),
      edited_decision_text: z.string().trim().min(1).max(2000).optional(),
      edited_action_items: z.array(actionItemSchema).max(10).optional(),
    },
    async (args) => {
      try {
        const data = await opsRequest<{
          status: 'accepted' | 'edited';
          ops_decision_id: string;
          kanban_card_ids: string[];
          kanban_boards: string[];
        }>('POST', `/api/ops/board/sessions/${args.session_id}/decision/accept`, {
          actor_name: args.actor_name,
          edited_decision_text: args.edited_decision_text,
          edited_action_items: args.edited_action_items,
        });
        return textResult(
          `Decision ${data.status}.\n  ops.decisions row: ${data.ops_decision_id}\n  kanban cards (${data.kanban_card_ids.length}): ${data.kanban_card_ids.join(', ') || '(none)'}\n  boards: ${data.kanban_boards.join(', ') || '(none)'}`,
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_decision_reject',
    'Reject a proposed decision with a required reason. The reason is saved on the decision row for the record. No action sinks fire.',
    {
      session_id: z.string().uuid(),
      reason: z.string().trim().min(1).max(2000),
    },
    async (args) => {
      try {
        await opsRequest('POST', `/api/ops/board/sessions/${args.session_id}/decision/reject`, {
          reason: args.reason,
        });
        return textResult(`Rejected session ${args.session_id.slice(0, 8)}.`);
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_session_delete',
    'Hard-delete a board session and its transcript / cruxes / positions / proposed decision. Refuses if the session was accepted (would orphan the spawned ops.decisions row and kanban cards). Use for failed/junk sessions.',
    {
      session_id: z.string().uuid(),
      reason: z.string().trim().min(1).max(500).describe('Why the deletion (logged to audit_log)'),
    },
    async (args) => {
      try {
        await opsRequest('DELETE', `/api/ops/board/sessions/${args.session_id}`, undefined, {
          reason: args.reason,
        });
        return textResult(`Deleted session ${args.session_id.slice(0, 8)}.`);
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_leaderboard',
    "Cumulative performance records for every advisor across all sessions. Returns sessions, positions taken, credited/overruled counts and rates, concession rate, avg per-message rating from Jonathan, and outcome attribution (proven_right_credit, proven_wrong_credit, overruled_but_right). Role-aware: a high overrule rate is EXPECTED for the Devil's Advocate.",
    {},
    async () => {
      try {
        const data = await opsRequest<{
          leaderboard: Array<{
            slug: string;
            name: string;
            emoji: string;
            role_kind: 'expert' | 'challenger' | 'chair';
            sessions: number;
            positions_taken: number;
            credited: number;
            overruled: number;
            concessions: number;
            credit_rate: number | null;
            overrule_rate: number | null;
            avg_human_rating: number | null;
            proven_right_credit: number;
            proven_wrong_credit: number;
            overruled_but_right: number;
          }>;
        }>('GET', '/api/ops/board/leaderboard');
        if (data.leaderboard.length === 0) return textResult('No advisor data yet.');

        let out = `Leaderboard (${data.leaderboard.length} advisors):\n\n`;
        for (const r of data.leaderboard) {
          out += `${r.emoji} ${r.name} [${r.role_kind}]\n`;
          out += `  ${r.sessions} sessions, ${r.positions_taken} positions\n`;
          out += `  credited ${r.credited}${r.credit_rate !== null ? ` (${r.credit_rate}%)` : ''} · overruled ${r.overruled}${r.overrule_rate !== null ? ` (${r.overrule_rate}%)` : ''} · conceded ${r.concessions}\n`;
          if (r.avg_human_rating !== null) out += `  avg rating ${r.avg_human_rating}/5\n`;
          if (r.proven_right_credit + r.proven_wrong_credit + r.overruled_but_right > 0) {
            out += `  outcomes: ✓${r.proven_right_credit} proven-right, ✗${r.proven_wrong_credit} proven-wrong`;
            if (r.overruled_but_right > 0) out += `, !${r.overruled_but_right} overruled-but-right`;
            out += '\n';
          }
          out += '\n';
        }
        return textResult(out.trim());
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.tool(
    'board_advisor_stats',
    'Detailed record for one advisor: stats + recent positions + decisions where credited/overruled + recent rated messages with notes. Use the slug or UUID. Useful when deciding which advisor to retire, sharpen, or weight differently.',
    {
      advisor_id: z.string().uuid().describe('The advisor UUID (from board_advisors_list)'),
    },
    async ({ advisor_id }) => {
      try {
        const data = await opsRequest<{
          advisor: { slug: string; name: string; emoji: string; role_kind: string; title: string };
          stat: {
            sessions: number;
            positions_taken: number;
            credited: number;
            overruled: number;
            concessions: number;
            avg_human_rating: number | null;
            proven_right_credit: number;
            proven_wrong_credit: number;
            overruled_but_right: number;
          } | null;
          positions: Array<{
            session_title: string;
            crux_label: string | null;
            stance: string;
            confidence: number;
            shifted_from_opening: boolean;
            session_created_at: string;
          }>;
          rated_messages: Array<{
            session_title: string;
            turn_kind: string;
            content_preview: string;
            advisor_rating: number;
            review_note: string | null;
          }>;
          decisions: Array<{
            session_title: string;
            decision_text: string;
            link_kind: 'credited' | 'overruled';
            outcome: string;
            overrule_reason: string | null;
          }>;
        }>('GET', `/api/ops/board/advisors/${advisor_id}/stats`);

        const a = data.advisor;
        const s = data.stat;
        let out = `${a.emoji} ${a.name} [${a.role_kind}] — ${a.title}\n\n`;

        if (s) {
          out += `## Numbers\n`;
          out += `${s.sessions} sessions · ${s.positions_taken} positions · credited ${s.credited} · overruled ${s.overruled} · conceded ${s.concessions}\n`;
          if (s.avg_human_rating !== null) out += `Avg rating ${s.avg_human_rating}/5\n`;
          if (s.proven_right_credit + s.proven_wrong_credit + s.overruled_but_right > 0) {
            out += `Outcomes: ✓${s.proven_right_credit} proven-right, ✗${s.proven_wrong_credit} proven-wrong`;
            if (s.overruled_but_right > 0) out += `, !${s.overruled_but_right} overruled-but-right`;
            out += '\n';
          }
          out += '\n';
        }

        if (data.positions.length > 0) {
          out += `## Recent positions (${data.positions.length})\n`;
          for (const p of data.positions.slice(0, 10)) {
            const shifted = p.shifted_from_opening ? ' (shifted)' : '';
            const crux = p.crux_label ? ` [${p.crux_label}]` : '';
            out += `- ${p.session_title}${crux}: ${p.stance} (${p.confidence}/5${shifted})\n`;
          }
          out += '\n';
        }

        if (data.decisions.length > 0) {
          const credited = data.decisions.filter((d) => d.link_kind === 'credited');
          const overruled = data.decisions.filter((d) => d.link_kind === 'overruled');
          if (credited.length > 0) {
            out += `## Credited (${credited.length})\n`;
            for (const d of credited.slice(0, 8))
              out += `- ${d.session_title}: ${d.decision_text.slice(0, 160)}${d.decision_text.length > 160 ? '…' : ''}\n`;
            out += '\n';
          }
          if (overruled.length > 0) {
            out += `## Overruled (${overruled.length})\n`;
            for (const d of overruled.slice(0, 8)) {
              out += `- ${d.session_title}: ${d.decision_text.slice(0, 160)}${d.decision_text.length > 160 ? '…' : ''}\n`;
              if (d.overrule_reason) out += `  Chair: "${d.overrule_reason}"\n`;
            }
            out += '\n';
          }
        }

        if (data.rated_messages.length > 0) {
          out += `## Recent rated messages (${data.rated_messages.length})\n`;
          for (const m of data.rated_messages.slice(0, 8)) {
            out += `- [${m.advisor_rating}/5] ${m.session_title} (${m.turn_kind}): ${m.content_preview.slice(0, 200)}${m.content_preview.length > 200 ? '…' : ''}\n`;
            if (m.review_note) out += `  Note: "${m.review_note}"\n`;
          }
        }

        return textResult(out);
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );
}
