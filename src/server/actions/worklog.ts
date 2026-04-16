'use server';

/**
 * Server actions for user-authored work log notes.
 *
 * Only `entry_type = 'note'` entries are editable from the app layer.
 * System and milestone entries are emitted by other tracks (e.g. Track C's
 * `changeJobStatusAction`) and must not be mutable from the UI — the update
 * and delete actions filter on `entry_type = 'note'` as a safety net on top
 * of RLS.
 *
 * Spec: PHASE_1_PLAN.md §8 Track E.
 */

import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import {
  emptyToNull,
  worklogNoteCreateSchema,
  worklogNoteUpdateSchema,
} from '@/lib/validators/worklog';

export type WorklogActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type WorklogNoteFormInput = {
  title: string;
  body?: string;
  related_type?: string;
  related_id?: string;
};

export async function createWorklogNoteAction(
  input: WorklogNoteFormInput,
): Promise<WorklogActionResult> {
  const parsed = worklogNoteCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return { ok: false, error: 'Not signed in or missing tenant.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, error: 'Not signed in.' };
  }

  const { data, error } = await supabase
    .from('worklog_entries')
    .insert({
      tenant_id: tenant.id,
      user_id: user.id,
      entry_type: 'note',
      title: parsed.data.title,
      body: emptyToNull(parsed.data.body),
      related_type: parsed.data.related_type ?? null,
      related_id: emptyToNull(parsed.data.related_id),
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to create note.' };
  }

  revalidatePath('/inbox');
  return { ok: true, id: data.id };
}

export async function updateWorklogNoteAction(
  input: WorklogNoteFormInput & { id: string },
): Promise<WorklogActionResult> {
  const parsed = worklogNoteUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('worklog_entries')
    .update({
      title: parsed.data.title,
      body: emptyToNull(parsed.data.body),
      related_type: parsed.data.related_type ?? null,
      related_id: emptyToNull(parsed.data.related_id),
      updated_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.id)
    .eq('entry_type', 'note');

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/inbox');
  return { ok: true, id: parsed.data.id };
}

/**
 * Delete a note. Only `entry_type = 'note'` rows are eligible — system and
 * milestone entries are immutable from the UI layer.
 */
export async function deleteWorklogNoteAction(id: string): Promise<WorklogActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing entry id.' };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from('worklog_entries')
    .delete()
    .eq('id', id)
    .eq('entry_type', 'note');

  if (error) {
    return { ok: false, error: error.message };
  }

  revalidatePath('/inbox');
  return { ok: true, id };
}
