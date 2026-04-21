'use server';

import { revalidatePath } from 'next/cache';
import { requireAdmin } from '@/lib/ops-gate';
import { createServiceClient } from '@/lib/supabase';

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createWorklogEntryAction(input: {
  title: string;
  body: string | null;
  category: string | null;
  site: string | null;
  tags: string[];
}): Promise<ActionResult> {
  const admin = await requireAdmin();
  if (!input.title.trim()) return { ok: false, error: 'Title is required.' };

  const service = createServiceClient();
  const { error } = await service.schema('ops').from('worklog_entries').insert({
    actor_type: 'human',
    actor_name: admin.email,
    admin_user_id: admin.userId,
    title: input.title.trim(),
    body: input.body,
    category: input.category,
    site: input.site,
    tags: input.tags,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/worklog');
  revalidatePath('/dashboard');
  return { ok: true };
}

export async function archiveWorklogEntryAction(id: string): Promise<ActionResult> {
  await requireAdmin();
  const service = createServiceClient();
  const { error } = await service
    .schema('ops')
    .from('worklog_entries')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);
  if (error) return { ok: false, error: error.message };
  revalidatePath('/worklog');
  return { ok: true };
}
