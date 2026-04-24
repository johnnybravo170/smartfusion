import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type ActorCtx,
  archiveCard,
  assignCard,
  blockCard,
  claimCard,
  commentCard,
  createCard,
  getCard,
  KANBAN_COLUMNS,
  listBoards,
  listCards,
  moveCard,
  releaseCard,
  unblockCard,
  updateCard,
} from '@/server/ops-services/kanban';
import {
  FIBONACCI_SIZES,
  getEta,
  getLaunchRollup,
  getNextForAssignee,
  getVelocity,
  type SizePoints,
  setCardSize,
} from '@/server/ops-services/launch';
import { jsonResult, type McpToolCtx, withAudit } from './context';

const COLUMN_ENUM = z.enum(KANBAN_COLUMNS);

function actor(ctx: McpToolCtx): ActorCtx {
  return {
    actorType: 'agent',
    actorName: ctx.actorName,
    keyId: ctx.keyId,
    adminUserId: null,
  };
}

export function registerKanbanTools(server: McpServer, ctx: McpToolCtx) {
  server.tool(
    'kanban_boards_list',
    'List all kanban boards with per-column card counts. Use this first to discover available boards (dev / marketing / research / ops).',
    {},
    withAudit(ctx, 'kanban_boards_list', 'read:kanban', async () => {
      const boards = await listBoards();
      return jsonResult({ boards });
    }),
  );

  server.tool(
    'kanban_card_list',
    'List kanban cards on a board. Filter by column, assignee, tags. By default excludes archived cards and excludes the `blocked` column. Use this to see what\u2019s in flight before creating work.',
    {
      board_slug: z.string().min(1),
      column: COLUMN_ENUM.optional(),
      assignee: z.string().max(200).optional(),
      tags: z.array(z.string()).max(20).optional(),
      include_blocked: z.boolean().optional().default(false),
      include_archived: z.boolean().optional().default(false),
      limit: z.number().int().min(1).max(500).optional().default(200),
    },
    withAudit(ctx, 'kanban_card_list', 'read:kanban', async (input) => {
      const cards = await listCards({
        boardSlug: input.board_slug,
        column: input.column,
        assignee: input.assignee,
        tags: input.tags,
        includeBlocked: input.include_blocked,
        includeArchived: input.include_archived,
        limit: input.limit,
      });
      return jsonResult({ cards });
    }),
  );

  server.tool(
    'kanban_card_get',
    'Fetch a single kanban card plus its 30 most recent events (moves, comments, claims, etc). Always call this before editing a card you did not just create.',
    { id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_get', 'read:kanban', async ({ id }) => {
      const res = await getCard(id);
      if (!res) throw new Error('Card not found');
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_create',
    'Create a new kanban card. Default column is `backlog`. Set `suggested_agent` as a hint for which agent should pick it up. Use `recurring_rule` (e.g. "weekly:mon") to auto-spawn a successor when this card moves to done.',
    {
      board_slug: z.string().min(1),
      title: z.string().min(1).max(500),
      column: COLUMN_ENUM.optional(),
      body: z.string().max(20000).optional().nullable(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .nullable(),
      priority: z.number().int().min(1).max(5).optional().nullable(),
      assignee: z.string().max(200).optional().nullable(),
      suggested_agent: z.string().max(200).optional().nullable(),
      related_type: z.string().max(50).optional().nullable(),
      related_id: z.string().max(500).optional().nullable(),
      recurring_rule: z.string().max(100).optional().nullable(),
    },
    withAudit(ctx, 'kanban_card_create', 'write:kanban', async (input) => {
      const { id } = await createCard(actor(ctx), {
        boardSlug: input.board_slug,
        title: input.title,
        column: input.column,
        body: input.body,
        tags: input.tags,
        due_date: input.due_date,
        priority: input.priority,
        assignee: input.assignee,
        suggested_agent: input.suggested_agent,
        related_type: input.related_type,
        related_id: input.related_id,
        recurring_rule: input.recurring_rule,
      });
      return jsonResult({
        ok: true,
        id,
        url: `https://ops.heyhenry.io/admin/kanban/${input.board_slug}`,
      });
    }),
  );

  server.tool(
    'kanban_card_update',
    'Patch a kanban card (partial update). Only the provided fields are changed. Writes an `edited` event listing which fields changed.',
    {
      id: z.string().uuid(),
      title: z.string().min(1).max(500).optional(),
      body: z.string().max(20000).nullable().optional(),
      tags: z.array(z.string().min(1).max(50)).max(20).optional(),
      due_date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable()
        .optional(),
      priority: z.number().int().min(1).max(5).nullable().optional(),
      suggested_agent: z.string().max(200).nullable().optional(),
      related_type: z.string().max(50).nullable().optional(),
      related_id: z.string().max(500).nullable().optional(),
      recurring_rule: z.string().max(100).nullable().optional(),
    },
    withAudit(ctx, 'kanban_card_update', 'write:kanban', async ({ id, ...input }) => {
      const res = await updateCard(actor(ctx), id, input);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_move',
    "Move a card to another column (backlog/todo/doing/blocked/done). When moving to `done`, if the card has a recurring_rule, a new card is auto-spawned in backlog. Call this with column='done' whenever you finish work assigned to you.",
    {
      id: z.string().uuid(),
      column: COLUMN_ENUM,
      order_in_column: z.number().int().min(0).optional(),
    },
    withAudit(ctx, 'kanban_card_move', 'write:kanban', async ({ id, column, order_in_column }) => {
      const res = await moveCard(actor(ctx), id, column, order_in_column);
      return jsonResult({ ok: true, id: res.id, spawned_id: res.spawnedId });
    }),
  );

  server.tool(
    'kanban_card_claim',
    'Atomically claim a card — sets assignee to you only if no one else holds it. Returns `already_claimed` with the current holder\u2019s name otherwise. Use before starting work to avoid double-work.',
    { id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_claim', 'write:kanban', async ({ id }) => {
      const res = await claimCard(actor(ctx), id);
      if (!res.ok) return jsonResult({ ok: false, error: res.reason, assignee: res.assignee });
      return jsonResult({ ok: true, id, assignee: ctx.actorName });
    }),
  );

  server.tool(
    'kanban_card_release',
    'Release a card you currently hold — clears the assignee if it equals you. No-op error if you are not the assignee.',
    { id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_release', 'write:kanban', async ({ id }) => {
      const res = await releaseCard(actor(ctx), id);
      if (!res.ok) return jsonResult({ ok: false, error: res.reason });
      return jsonResult({ ok: true });
    }),
  );

  server.tool(
    'kanban_card_assign',
    'Force-assign a card to someone (agent name or `jonathan`). Unlike claim, this overwrites any existing assignee. Pass null to clear.',
    { id: z.string().uuid(), to: z.string().max(200).nullable() },
    withAudit(ctx, 'kanban_card_assign', 'write:kanban', async ({ id, to }) => {
      const res = await assignCard(actor(ctx), id, to);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_comment',
    'Add a comment event on a card. Use for notes, status updates, or questions for Jonathan. Does not mutate the card itself.',
    { id: z.string().uuid(), body: z.string().min(1).max(20000) },
    withAudit(ctx, 'kanban_card_comment', 'write:kanban', async ({ id, body }) => {
      const res = await commentCard(actor(ctx), id, body);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_block',
    'Mark a card as blocked by another card. Adds `blocked_by_id` to the card\u2019s blocked_by array (idempotent).',
    { id: z.string().uuid(), blocked_by_id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_block', 'write:kanban', async ({ id, blocked_by_id }) => {
      const res = await blockCard(actor(ctx), id, blocked_by_id);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_unblock',
    'Remove a blocker from a card\u2019s blocked_by array.',
    { id: z.string().uuid(), blocked_by_id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_unblock', 'write:kanban', async ({ id, blocked_by_id }) => {
      const res = await unblockCard(actor(ctx), id, blocked_by_id);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_card_size',
    'Set a card\u2019s size_points estimate. Must be a Fibonacci value: 1, 2, 3, 5, 8, 13, or 21. Pass null to clear. Sizing unsized cards directly improves launch-progress forecasting.',
    {
      id: z.string().uuid(),
      size_points: z.union([
        z.literal(1),
        z.literal(2),
        z.literal(3),
        z.literal(5),
        z.literal(8),
        z.literal(13),
        z.literal(21),
        z.null(),
      ]),
    },
    withAudit(ctx, 'kanban_card_size', 'write:kanban', async ({ id, size_points }) => {
      if (size_points !== null && !FIBONACCI_SIZES.includes(size_points as SizePoints)) {
        throw new Error('size_points must be Fibonacci: 1,2,3,5,8,13,21');
      }
      const res = await setCardSize(id, size_points as SizePoints | null);
      return jsonResult(res);
    }),
  );

  server.tool(
    'kanban_launch_rollup',
    'HeyHenry V1 launch readiness summary: percent complete, velocity, and ETA. Returns a one-paragraph human summary plus structured numbers. Read-only.',
    {},
    withAudit(ctx, 'kanban_launch_rollup', 'read:kanban', async () => {
      const rollup = await getLaunchRollup();
      const velocity = await getVelocity(28);
      const remaining = Math.max(0, rollup.totalPoints - rollup.donePoints);
      const eta = getEta(remaining, velocity.weeklyRate);
      const unsizedNote =
        rollup.unsizedCards > 0
          ? ` ${rollup.unsizedCards} cards are unsized, so % is an under-count.`
          : '';
      const etaText = eta
        ? `At ${velocity.weeklyRate.toFixed(1)} pts/week, ETA ~${eta.weeks} weeks (around ${eta.date}).`
        : velocity.completedPoints === 0
          ? 'No cards completed in last 28 days \u2014 velocity is zero, ETA unknown.'
          : 'Remaining work is zero.';
      const summary = `HeyHenry V1: ${rollup.percentDone}% ready (${rollup.donePoints}/${rollup.totalPoints} pts across ${rollup.blockerCardCount} launch-blocker cards).${unsizedNote} ${etaText}`;
      return jsonResult({ summary, rollup, velocity, eta });
    }),
  );

  server.tool(
    'kanban_next_for_me',
    "Returns Jonathan\u2019s highest-priority unblocked card (todo or backlog). Use when asked 'what should I do next?'. Read-only.",
    {},
    withAudit(ctx, 'kanban_next_for_me', 'read:kanban', async () => {
      const card = await getNextForAssignee('jonathan');
      return jsonResult({ card });
    }),
  );

  server.tool(
    'kanban_card_archive',
    'Archive a card (soft delete). Hides from default lists; history preserved.',
    { id: z.string().uuid() },
    withAudit(ctx, 'kanban_card_archive', 'write:kanban', async ({ id }) => {
      const res = await archiveCard(actor(ctx), id);
      return jsonResult(res);
    }),
  );
}
