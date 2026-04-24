'use server';

/**
 * Server actions for the contact notes feed (see migration 0111).
 *
 * All mutations go through the RLS-aware client so tenant scoping and
 * permission checks happen at the DB boundary. Operator-authored notes
 * carry the current user's tenant_member id as `author_id`.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';

export type ContactNoteActionResult = { ok: true; id: string } | { ok: false; error: string };

const addNoteSchema = z.object({
  contactId: z.string().uuid(),
  body: z.string().trim().min(1, 'Empty note.').max(10000, 'Note too long.'),
});

export async function addContactNoteAction(input: {
  contactId: string;
  body: string;
}): Promise<ContactNoteActionResult> {
  const parsed = addNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('contact_notes')
    .insert({
      tenant_id: tenant.id,
      contact_id: parsed.data.contactId,
      author_type: 'operator',
      body: parsed.data.body,
    })
    .select('id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to add note.' };
  }

  revalidatePath(`/contacts/${parsed.data.contactId}`);
  return { ok: true, id: data.id };
}

const editNoteSchema = z.object({
  noteId: z.string().uuid(),
  body: z.string().trim().min(1).max(10000),
});

export async function editContactNoteAction(input: {
  noteId: string;
  body: string;
}): Promise<ContactNoteActionResult> {
  const parsed = editNoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('contact_notes')
    .update({ body: parsed.data.body, updated_at: new Date().toISOString() })
    .eq('id', parsed.data.noteId)
    .select('id, contact_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to edit note.' };
  }

  revalidatePath(`/contacts/${data.contact_id}`);
  return { ok: true, id: data.id };
}

export async function deleteContactNoteAction(noteId: string): Promise<ContactNoteActionResult> {
  if (!noteId) return { ok: false, error: 'Missing note id.' };

  const supabase = await createClient();
  const { data: noteRow } = await supabase
    .from('contact_notes')
    .select('contact_id')
    .eq('id', noteId)
    .single();

  const { error } = await supabase.from('contact_notes').delete().eq('id', noteId);
  if (error) return { ok: false, error: error.message };

  if (noteRow?.contact_id) {
    revalidatePath(`/contacts/${noteRow.contact_id}`);
  }
  return { ok: true, id: noteId };
}
