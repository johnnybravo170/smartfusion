import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { describeError, opsRequest } from '../client.js';
import { errorResult, formatDateTime, textResult } from '../types.js';

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
}
