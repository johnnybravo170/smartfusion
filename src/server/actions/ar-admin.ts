'use server';

/**
 * AR admin server actions — platform-scope mutations from the /admin/ar/* UI.
 *
 * Auth: `requirePlatformAdmin()` gates every action. Writes use the
 * service-role client so RLS doesn't get in the way of NULL-tenant rows.
 */

import { revalidatePath } from 'next/cache';
import { requirePlatformAdmin } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

type Result = { ok: true } | { ok: false; error: string };

const VALID_STATUSES = ['draft', 'active', 'paused', 'archived'] as const;
type SequenceStatus = (typeof VALID_STATUSES)[number];

export async function setArSequenceStatusAction(
  sequenceId: string,
  status: SequenceStatus,
): Promise<Result> {
  await requirePlatformAdmin();

  if (!VALID_STATUSES.includes(status)) {
    return { ok: false, error: `invalid status: ${status}` };
  }

  const admin = createAdminClient();

  // Confirm it's a platform-scope sequence before touching it.
  const { data: seq, error: seqErr } = await admin
    .from('ar_sequences')
    .select('id, version, status')
    .eq('id', sequenceId)
    .is('tenant_id', null)
    .maybeSingle();
  if (seqErr) return { ok: false, error: seqErr.message };
  if (!seq) return { ok: false, error: 'sequence not found' };

  // Don't let a user activate an empty sequence from the UI — matches MCP rule.
  if (status === 'active') {
    const { count } = await admin
      .from('ar_steps')
      .select('*', { count: 'exact', head: true })
      .eq('sequence_id', sequenceId)
      .eq('version', seq.version);
    if (!count || count === 0) {
      return { ok: false, error: 'cannot activate a sequence with no steps' };
    }
  }

  const { error: updErr } = await admin
    .from('ar_sequences')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', sequenceId);
  if (updErr) return { ok: false, error: updErr.message };

  if (status === 'archived') {
    await admin
      .from('ar_enrollments')
      .update({ status: 'cancelled' })
      .eq('sequence_id', sequenceId)
      .eq('status', 'active');
  }

  revalidatePath('/admin/ar/sequences');
  revalidatePath(`/admin/ar/sequences/${sequenceId}`);
  return { ok: true };
}
