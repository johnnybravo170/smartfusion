/**
 * Shared kanban service — used by both MCP tools (agent-facing) and
 * admin UI server actions (human-facing). All mutations log to
 * ops.kanban_card_events. All callers pass an ActorCtx so the audit
 * trail reflects the true caller (human admin vs agent).
 */
import { createServiceClient } from '@/lib/supabase';

export type ActorCtx = {
  actorType: 'human' | 'agent' | 'system';
  actorName: string;
  keyId: string | null;
  adminUserId: string | null;
};

export const KANBAN_COLUMNS = ['backlog', 'todo', 'doing', 'blocked', 'done'] as const;
export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];

export type ServiceResult<T> = { ok: true; value: T } | { ok: false; error: string };

type Svc = ReturnType<typeof createServiceClient>;

async function logEvent(
  service: Svc,
  cardId: string,
  ctx: ActorCtx,
  eventType: string,
  body: string | null,
  metadata: Record<string, unknown> = {},
) {
  await service.schema('ops').from('kanban_card_events').insert({
    card_id: cardId,
    event_type: eventType,
    body,
    metadata,
    actor_type: ctx.actorType,
    actor_name: ctx.actorName,
    key_id: ctx.keyId,
  });
}

async function resolveBoardId(service: Svc, slug: string): Promise<string | null> {
  const { data } = await service
    .schema('ops')
    .from('kanban_boards')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  return (data?.id as string) ?? null;
}

export async function listBoards() {
  const service = createServiceClient();
  const { data: boards, error } = await service
    .schema('ops')
    .from('kanban_boards')
    .select('id, name, slug, description, sort_order, created_at, updated_at')
    .order('sort_order');
  if (error) throw new Error(error.message);

  const { data: cards } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('board_id, column_key')
    .is('archived_at', null);

  const countsByBoard = new Map<string, Record<string, number>>();
  for (const c of cards ?? []) {
    const bid = c.board_id as string;
    const col = c.column_key as string;
    let map = countsByBoard.get(bid);
    if (!map) {
      map = {};
      countsByBoard.set(bid, map);
    }
    map[col] = (map[col] ?? 0) + 1;
  }

  return (boards ?? []).map((b) => ({
    id: b.id as string,
    name: b.name as string,
    slug: b.slug as string,
    description: b.description as string | null,
    sort_order: b.sort_order as number,
    counts: countsByBoard.get(b.id as string) ?? {},
  }));
}

export type CardListFilter = {
  boardSlug: string;
  column?: KanbanColumn;
  assignee?: string;
  tags?: string[];
  includeBlocked?: boolean;
  includeArchived?: boolean;
  limit?: number;
};

export async function listCards(f: CardListFilter) {
  const service = createServiceClient();
  const boardId = await resolveBoardId(service, f.boardSlug);
  if (!boardId) throw new Error(`Unknown board: ${f.boardSlug}`);

  let q = service
    .schema('ops')
    .from('kanban_cards')
    .select(
      'id, board_id, column_key, title, body, tags, due_date, priority, order_in_column, assignee, suggested_agent, blocked_by, related_type, related_id, recurring_rule, recurring_parent_id, actor_type, actor_name, created_at, updated_at, done_at, archived_at',
    )
    .eq('board_id', boardId)
    .order('column_key')
    .order('order_in_column')
    .limit(f.limit ?? 500);

  if (!f.includeArchived) q = q.is('archived_at', null);
  if (f.column) q = q.eq('column_key', f.column);
  if (f.assignee) q = q.eq('assignee', f.assignee);
  if (f.tags && f.tags.length > 0) q = q.contains('tags', f.tags);
  if (!f.includeBlocked) q = q.neq('column_key', 'blocked');

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getCard(id: string) {
  const service = createServiceClient();
  const { data: card, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!card) return null;

  const { data: events } = await service
    .schema('ops')
    .from('kanban_card_events')
    .select('id, event_type, body, metadata, actor_type, actor_name, created_at')
    .eq('card_id', id)
    .order('created_at', { ascending: false })
    .limit(30);

  return { card, events: events ?? [] };
}

export type CreateCardInput = {
  boardSlug: string;
  title: string;
  column?: KanbanColumn;
  body?: string | null;
  tags?: string[];
  due_date?: string | null;
  priority?: number | null;
  assignee?: string | null;
  suggested_agent?: string | null;
  related_type?: string | null;
  related_id?: string | null;
  recurring_rule?: string | null;
  recurring_parent_id?: string | null;
};

export async function createCard(ctx: ActorCtx, input: CreateCardInput) {
  const service = createServiceClient();
  const boardId = await resolveBoardId(service, input.boardSlug);
  if (!boardId) throw new Error(`Unknown board: ${input.boardSlug}`);

  const column = input.column ?? 'backlog';
  const { data: maxRow } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('order_in_column')
    .eq('board_id', boardId)
    .eq('column_key', column)
    .order('order_in_column', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextOrder = ((maxRow?.order_in_column as number | undefined) ?? -1) + 1;

  const { data, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .insert({
      board_id: boardId,
      column_key: column,
      title: input.title,
      body: input.body ?? null,
      tags: input.tags ?? [],
      due_date: input.due_date ?? null,
      priority: input.priority ?? null,
      order_in_column: nextOrder,
      assignee: input.assignee ?? null,
      suggested_agent: input.suggested_agent ?? null,
      related_type: input.related_type ?? null,
      related_id: input.related_id ?? null,
      recurring_rule: input.recurring_rule ?? null,
      recurring_parent_id: input.recurring_parent_id ?? null,
      actor_type: ctx.actorType,
      actor_name: ctx.actorName,
      key_id: ctx.keyId,
      admin_user_id: ctx.adminUserId,
    })
    .select('id, created_at')
    .single();
  if (error || !data) throw new Error(error?.message ?? 'Insert failed');

  await logEvent(service, data.id as string, ctx, 'created', null, {
    board_slug: input.boardSlug,
    column,
  });
  return { id: data.id as string };
}

export type UpdateCardInput = {
  title?: string;
  body?: string | null;
  tags?: string[];
  due_date?: string | null;
  priority?: number | null;
  suggested_agent?: string | null;
  related_type?: string | null;
  related_id?: string | null;
  recurring_rule?: string | null;
};

export async function updateCard(ctx: ActorCtx, id: string, input: UpdateCardInput) {
  const service = createServiceClient();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    patch[k] = v;
    changed[k] = v;
  }
  if (Object.keys(changed).length === 0) return { ok: true as const, changed: false };

  const { error } = await service.schema('ops').from('kanban_cards').update(patch).eq('id', id);
  if (error) throw new Error(error.message);

  await logEvent(service, id, ctx, 'edited', null, { fields: Object.keys(changed) });
  return { ok: true as const, changed: true };
}

export async function moveCard(
  ctx: ActorCtx,
  id: string,
  column: KanbanColumn,
  orderInColumn?: number,
): Promise<{ id: string; spawnedId: string | null }> {
  const service = createServiceClient();

  const { data: cur, error: curErr } = await service
    .schema('ops')
    .from('kanban_cards')
    .select(
      'id, board_id, column_key, title, body, tags, assignee, suggested_agent, priority, due_date, recurring_rule, related_type, related_id',
    )
    .eq('id', id)
    .maybeSingle();
  if (curErr) throw new Error(curErr.message);
  if (!cur) throw new Error('Card not found');

  const fromColumn = cur.column_key as string;

  let order = orderInColumn;
  if (order === undefined) {
    const { data: maxRow } = await service
      .schema('ops')
      .from('kanban_cards')
      .select('order_in_column')
      .eq('board_id', cur.board_id as string)
      .eq('column_key', column)
      .order('order_in_column', { ascending: false })
      .limit(1)
      .maybeSingle();
    order = ((maxRow?.order_in_column as number | undefined) ?? -1) + 1;
  }

  const patch: Record<string, unknown> = {
    column_key: column,
    order_in_column: order,
    updated_at: new Date().toISOString(),
  };
  if (column === 'done') patch.done_at = new Date().toISOString();

  const { error } = await service.schema('ops').from('kanban_cards').update(patch).eq('id', id);
  if (error) throw new Error(error.message);

  await logEvent(service, id, ctx, 'moved', null, { from: fromColumn, to: column });

  // Recurring auto-spawn.
  let spawnedId: string | null = null;
  if (column === 'done' && cur.recurring_rule) {
    const { data: spawn, error: spawnErr } = await service
      .schema('ops')
      .from('kanban_cards')
      .insert({
        board_id: cur.board_id as string,
        column_key: 'backlog',
        title: cur.title as string,
        body: (cur.body as string | null) ?? null,
        tags: (cur.tags as string[] | null) ?? [],
        priority: (cur.priority as number | null) ?? null,
        due_date: null,
        order_in_column: 0,
        assignee: (cur.assignee as string | null) ?? null,
        suggested_agent: (cur.suggested_agent as string | null) ?? null,
        related_type: (cur.related_type as string | null) ?? null,
        related_id: (cur.related_id as string | null) ?? null,
        recurring_rule: cur.recurring_rule as string,
        recurring_parent_id: id,
        actor_type: ctx.actorType,
        actor_name: ctx.actorName,
        key_id: ctx.keyId,
      })
      .select('id')
      .single();
    if (spawnErr) throw new Error(spawnErr.message);
    spawnedId = spawn?.id as string;
    await logEvent(service, spawnedId, ctx, 'recurring_spawned', null, {
      parent_card_id: id,
      rule: cur.recurring_rule,
    });
  }

  return { id, spawnedId };
}

export async function claimCard(ctx: ActorCtx, id: string) {
  const service = createServiceClient();
  // Atomic: only claim if assignee is null.
  const { data, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ assignee: ctx.actorName, updated_at: new Date().toISOString() })
    .eq('id', id)
    .is('assignee', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (!data) {
    const { data: cur } = await service
      .schema('ops')
      .from('kanban_cards')
      .select('assignee')
      .eq('id', id)
      .maybeSingle();
    return {
      ok: false as const,
      reason: 'already_claimed',
      assignee: (cur?.assignee as string | null) ?? null,
    };
  }

  await logEvent(service, id, ctx, 'claimed', null, { assignee: ctx.actorName });
  return { ok: true as const };
}

export async function releaseCard(ctx: ActorCtx, id: string) {
  const service = createServiceClient();
  const { data, error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ assignee: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('assignee', ctx.actorName)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return { ok: false as const, reason: 'not_assignee' };
  await logEvent(service, id, ctx, 'released', null, {});
  return { ok: true as const };
}

export async function assignCard(ctx: ActorCtx, id: string, to: string | null) {
  const service = createServiceClient();
  const { data: cur } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('assignee')
    .eq('id', id)
    .maybeSingle();
  const prev = (cur?.assignee as string | null) ?? null;

  const { error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ assignee: to, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);

  await logEvent(service, id, ctx, 'assigned', null, { from: prev, to });
  return { ok: true as const };
}

export async function commentCard(ctx: ActorCtx, id: string, body: string) {
  const service = createServiceClient();
  await logEvent(service, id, ctx, 'commented', body, {});
  return { ok: true as const };
}

export async function blockCard(ctx: ActorCtx, id: string, blockedById: string) {
  const service = createServiceClient();
  const { data: cur } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('blocked_by')
    .eq('id', id)
    .maybeSingle();
  const list = ((cur?.blocked_by as string[] | null) ?? []).slice();
  if (!list.includes(blockedById)) list.push(blockedById);

  const { error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ blocked_by: list, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);

  await logEvent(service, id, ctx, 'blocked', null, { blocked_by_id: blockedById });
  return { ok: true as const };
}

export async function unblockCard(ctx: ActorCtx, id: string, blockedById: string) {
  const service = createServiceClient();
  const { data: cur } = await service
    .schema('ops')
    .from('kanban_cards')
    .select('blocked_by')
    .eq('id', id)
    .maybeSingle();
  const list = ((cur?.blocked_by as string[] | null) ?? []).filter((x) => x !== blockedById);

  const { error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ blocked_by: list, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);

  await logEvent(service, id, ctx, 'unblocked', null, { blocked_by_id: blockedById });
  return { ok: true as const };
}

export async function archiveCard(ctx: ActorCtx, id: string) {
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('kanban_cards')
    .update({ archived_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
  await logEvent(service, id, ctx, 'archived', null, {});
  return { ok: true as const };
}
