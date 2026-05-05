'use server';

import { revalidatePath } from 'next/cache';
import { createSessionInputSchema } from '@/lib/board/types';
import { requireAdmin } from '@/lib/ops-gate';
import { createSession, getSession } from '@/server/ops-services/board';
import { runDiscussion } from '@/server/ops-services/board-discussion';

type ActionResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

export async function createBoardSessionAction(input: {
  title: string;
  topic: string;
  advisor_ids: string[];
  provider_override?: 'anthropic' | 'openrouter' | null;
  model_override?: string | null;
  budget_cents?: number;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();

  const parsed = createSessionInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }

  try {
    const s = await createSession(parsed.data, { admin_user_id: admin.userId, key_id: null });
    revalidatePath('/board');
    return { ok: true, id: s.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'failed' };
  }
}

export async function runBoardSessionAction(session_id: string): Promise<ActionResult> {
  await requireAdmin();

  const s = await getSession(session_id);
  if (!s) return { ok: false, error: 'session not found' };
  if (s.status !== 'pending')
    return { ok: false, error: `session is ${s.status}; must be pending` };

  // Fire-and-forget. Revalidate triggers the page to re-render and start polling.
  void runDiscussion(session_id).catch((err) => {
    console.error(`[board.run] ${session_id} failed:`, err);
  });

  revalidatePath(`/board/sessions/${session_id}`);
  revalidatePath('/board');
  return { ok: true };
}
