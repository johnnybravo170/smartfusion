'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/ops-gate';
import { createServiceClient } from '@/lib/supabase';
import { createCard } from '@/server/ops-services/kanban';

export type ActionResult = { ok: true } | { ok: false; error: string };
export type PromoteResult = { ok: true; cardId: string } | { ok: false; error: string };

const PROMOTE_BOARDS = ['dev', 'marketing', 'research', 'ops'] as const;
const PROMOTE_SIZES = [1, 2, 3, 5, 8, 13, 21];

export async function promoteIdeaToKanbanAction(
  ideaId: string,
  input: { boardSlug: string; sizePoints: number; priority: number },
): Promise<PromoteResult> {
  const admin = await requireAdmin();
  if (!PROMOTE_BOARDS.includes(input.boardSlug as (typeof PROMOTE_BOARDS)[number])) {
    return { ok: false, error: 'Invalid board.' };
  }
  if (!PROMOTE_SIZES.includes(input.sizePoints)) {
    return { ok: false, error: 'Invalid size.' };
  }
  if (input.priority < 1 || input.priority > 5) {
    return { ok: false, error: 'Priority must be 1–5.' };
  }

  const service = createServiceClient();
  const { data: idea, error: ideaErr } = await service
    .schema('ops')
    .from('ideas')
    .select('id, title, body, tags')
    .eq('id', ideaId)
    .maybeSingle();
  if (ideaErr) return { ok: false, error: ideaErr.message };
  if (!idea) return { ok: false, error: 'Idea not found.' };

  const ideaTags = (idea.tags as string[] | null) ?? [];
  const epicTags = ideaTags.filter((t) => t.startsWith('epic:'));
  const cardTags = Array.from(new Set(['from:idea', ...epicTags]));

  try {
    const res = await createCard(
      {
        actorType: 'human',
        actorName: admin.email,
        keyId: null,
        adminUserId: admin.userId,
      },
      {
        boardSlug: input.boardSlug,
        title: idea.title as string,
        body: (idea.body as string | null) ?? null,
        tags: cardTags,
        priority: input.priority,
        size_points: input.sizePoints,
        related_type: 'idea',
        related_id: ideaId,
      },
    );

    const nextTags = Array.from(new Set([...ideaTags, `promoted:${res.id}`]));
    await service
      .schema('ops')
      .from('ideas')
      .update({
        status: 'in_progress',
        tags: nextTags,
        updated_at: new Date().toISOString(),
      })
      .eq('id', ideaId);

    await service
      .schema('ops')
      .from('idea_comments')
      .insert({
        idea_id: ideaId,
        actor_type: 'system',
        actor_name: 'ops',
        admin_user_id: admin.userId,
        body: `Promoted to kanban (${input.boardSlug}). Card: /admin/kanban/${input.boardSlug}/${res.id}`,
      });

    revalidatePath(`/ideas/${ideaId}`);
    revalidatePath('/ideas');
    revalidatePath(`/admin/kanban/${input.boardSlug}`);
    return { ok: true, cardId: res.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Promote failed.' };
  }
}

const VALID_STATUS = ['new', 'reviewed', 'in_progress', 'done', 'rejected'];

export async function setIdeaStatusAction(id: string, status: string): Promise<ActionResult> {
  await requireAdmin();
  if (!VALID_STATUS.includes(status)) return { ok: false, error: 'Invalid status.' };
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('ideas')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ideas/${id}`);
  revalidatePath('/ideas');
  return { ok: true };
}

export async function rateIdeaAction(id: string, rating: number | null): Promise<ActionResult> {
  await requireAdmin();
  if (rating !== null && (rating < 1 || rating > 5)) {
    return { ok: false, error: 'Rating must be 1–5.' };
  }
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('ideas')
    .update({ rating, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ideas/${id}`);
  revalidatePath('/ideas');
  return { ok: true };
}

export async function assignIdeaAction(id: string, assignee: string | null): Promise<ActionResult> {
  await requireAdmin();
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('ideas')
    .update({ assignee, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ideas/${id}`);
  return { ok: true };
}

export async function addIdeaCommentAction(ideaId: string, body: string): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!body.trim()) return { ok: false, error: 'Comment body required.' };
  const service = createServiceClient();
  const { error } = await service.schema('ops').from('idea_comments').insert({
    idea_id: ideaId,
    actor_type: 'human',
    actor_name: admin.email,
    admin_user_id: admin.userId,
    body: body.trim(),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/ideas/${ideaId}`);
  return { ok: true };
}

const LANES = ['product', 'marketing', 'ops', 'sales', 'research'];

export async function queueFollowupAction(
  ideaId: string,
  kind: 'promote_to_roadmap' | 'assign' | 'generic_followup',
  payload: Record<string, unknown>,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  const service = createServiceClient();

  // promote_to_roadmap is now wired up — create the card immediately and
  // mark the followup resolved. assign/generic_followup still queue because
  // their downstream systems don't exist yet.
  let resolvedAt: string | null = null;
  let resolvedBySystem: string | null = null;
  if (kind === 'promote_to_roadmap') {
    const { data: idea } = await service
      .schema('ops')
      .from('ideas')
      .select('id, title, body, tags, rating')
      .eq('id', ideaId)
      .maybeSingle();
    if (!idea) return { ok: false, error: 'Idea not found.' };

    const lane =
      typeof payload.lane === 'string' && LANES.includes(payload.lane) ? payload.lane : 'product';
    const { data: card, error: cardErr } = await service
      .schema('ops')
      .from('roadmap_items')
      .insert({
        actor_type: 'human',
        actor_name: admin.email,
        admin_user_id: admin.userId,
        lane,
        title: idea.title as string,
        body: (idea.body as string | null) ?? null,
        tags: (idea.tags as string[]) ?? [],
        priority: (idea.rating as number | null) ?? null,
        source_idea_id: idea.id as string,
      })
      .select('id')
      .single();
    if (cardErr || !card) return { ok: false, error: cardErr?.message ?? 'Card create failed.' };

    await service
      .schema('ops')
      .from('roadmap_activity')
      .insert({
        item_id: card.id,
        actor_type: 'human',
        actor_name: admin.email,
        kind: 'promoted_from_idea',
        to_value: ideaId,
        note: typeof payload.note === 'string' ? payload.note : null,
      });

    // Move the idea itself into in_progress to reflect the promotion.
    await service
      .schema('ops')
      .from('ideas')
      .update({ status: 'in_progress', updated_at: new Date().toISOString() })
      .eq('id', ideaId);

    resolvedAt = new Date().toISOString();
    resolvedBySystem = 'roadmap';

    await service
      .schema('ops')
      .from('idea_comments')
      .insert({
        idea_id: ideaId,
        actor_type: 'system',
        actor_name: 'ops',
        admin_user_id: admin.userId,
        body: `Promoted to roadmap (${lane}). Card: /roadmap/${card.id}`,
      });
  } else {
    await service
      .schema('ops')
      .from('idea_comments')
      .insert({
        idea_id: ideaId,
        actor_type: 'system',
        actor_name: 'ops',
        admin_user_id: admin.userId,
        body: `Queued followup: ${kind}${payload.note ? ` — ${payload.note}` : ''}`,
      });
  }

  const { error } = await service.schema('ops').from('idea_followups').insert({
    idea_id: ideaId,
    kind,
    payload,
    requested_by: admin.userId,
    resolved_at: resolvedAt,
    resolved_by_system: resolvedBySystem,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/ideas/${ideaId}`);
  revalidatePath('/roadmap');
  return { ok: true };
}
