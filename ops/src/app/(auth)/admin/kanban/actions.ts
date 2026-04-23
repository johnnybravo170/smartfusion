'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/ops-gate';
import {
  archiveCard,
  assignCard,
  blockCard,
  type CreateCardInput,
  claimCard,
  commentCard,
  createCard,
  type KanbanColumn,
  moveCard,
  releaseCard,
  type UpdateCardInput,
  unblockCard,
  updateCard,
} from '@/server/ops-services/kanban';

export type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function adminCtx() {
  const admin = await requireAdmin();
  return {
    actor: {
      actorType: 'human' as const,
      actorName: admin.email,
      keyId: null,
      adminUserId: admin.userId,
    },
    slugPaths: (slug: string, cardId?: string) => {
      revalidatePath(`/admin/kanban/${slug}`);
      if (cardId) revalidatePath(`/admin/kanban/${slug}/${cardId}`);
    },
  };
}

export async function createCardAction(
  input: CreateCardInput & { boardSlug: string },
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    if (!input.title.trim()) return { ok: false, error: 'Title required.' };
    const res = await createCard(actor, { ...input, title: input.title.trim() });
    slugPaths(input.boardSlug);
    return { ok: true, id: res.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function updateCardAction(
  id: string,
  slug: string,
  input: UpdateCardInput,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await updateCard(actor, id, input);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function moveCardAction(
  id: string,
  slug: string,
  column: KanbanColumn,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await moveCard(actor, id, column);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function claimCardAction(id: string, slug: string): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    const res = await claimCard(actor, id);
    if (!res.ok) return { ok: false, error: `Already claimed by ${res.assignee ?? 'someone'}` };
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function releaseCardAction(id: string, slug: string): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    const res = await releaseCard(actor, id);
    if (!res.ok) return { ok: false, error: 'You are not the assignee.' };
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function assignCardAction(
  id: string,
  slug: string,
  to: string | null,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await assignCard(actor, id, to);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function commentCardAction(
  id: string,
  slug: string,
  body: string,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    if (!body.trim()) return { ok: false, error: 'Comment required.' };
    await commentCard(actor, id, body.trim());
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function blockCardAction(
  id: string,
  slug: string,
  blockedById: string,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await blockCard(actor, id, blockedById);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function unblockCardAction(
  id: string,
  slug: string,
  blockedById: string,
): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await unblockCard(actor, id, blockedById);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}

export async function archiveCardAction(id: string, slug: string): Promise<ActionResult> {
  try {
    const { actor, slugPaths } = await adminCtx();
    await archiveCard(actor, id);
    slugPaths(slug, id);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Failed.' };
  }
}
