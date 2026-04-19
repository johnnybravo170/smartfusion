'use server';

/**
 * Server actions for the Photos module (Track D).
 *
 * All mutations run through the RLS-aware server client. `uploadPhotoAction`
 * receives multipart FormData (we can't pass File through plain JSON); the
 * caller submits the File already resized on the client.
 *
 * Tenant is resolved via `getCurrentTenant` (NOT a JWT claim — same rule as
 * the rest of the app; see §13.1 of PHASE_1_PLAN.md). The path prefix that
 * Storage RLS checks is derived from that tenant id.
 *
 * Spec: PHASE_1_PLAN.md §8 Track D.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { deleteFromStorage, uploadToStorage } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';
import { emptyToNull, photoUpdateSchema, photoUploadSchema } from '@/lib/validators/photo';

export type PhotoActionResult =
  | { ok: true; id: string }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

/**
 * Ingest one photo: validate metadata, derive the path, write to storage,
 * then write the DB row. If the DB insert fails after storage succeeded, we
 * best-effort clean up the orphaned object — a leaked blob is worse than
 * a retry.
 */
export async function uploadPhotoAction(formData: FormData): Promise<PhotoActionResult> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No file uploaded.' };
  }

  const rawMeta = {
    job_id: String(formData.get('job_id') ?? ''),
    tag: String(formData.get('tag') ?? 'other'),
    caption: formData.get('caption') ? String(formData.get('caption')) : '',
  };

  const parsed = photoUploadSchema.safeParse(rawMeta);
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
  const photoId = randomUUID();
  const ext = deriveExtension(file);
  const contentType = file.type || 'image/jpeg';

  // 1. Upload to storage.
  const uploadRes = await uploadToStorage({
    tenantId: tenant.id,
    jobId: parsed.data.job_id,
    photoId,
    file,
    contentType,
    extension: ext,
  });
  if ('error' in uploadRes) {
    return { ok: false, error: `Upload failed: ${uploadRes.error}` };
  }

  // 2. Insert the row.
  const { data, error } = await supabase
    .from('photos')
    .insert({
      id: photoId,
      tenant_id: tenant.id,
      job_id: parsed.data.job_id,
      storage_path: uploadRes.path,
      tag: parsed.data.tag,
      caption: emptyToNull(parsed.data.caption),
    })
    .select('id')
    .single();

  if (error || !data) {
    // Roll back the storage write so we don't leak orphan objects.
    await deleteFromStorage(uploadRes.path).catch(() => {});
    return { ok: false, error: error?.message ?? 'Failed to record photo.' };
  }

  revalidatePath('/photos-demo');
  revalidatePath(`/jobs/${parsed.data.job_id}`);
  return { ok: true, id: data.id };
}

/**
 * Delete a photo: remove the object, then the row. Order matters — if the
 * row goes first and storage delete fails, the blob leaks and we've lost
 * the pointer to it. Doing storage first means a DB failure leaves a
 * referenceless row we can clean up with a later backfill.
 */
export async function deletePhotoAction(id: string): Promise<PhotoActionResult> {
  if (!id || typeof id !== 'string') {
    return { ok: false, error: 'Missing photo id.' };
  }

  const supabase = await createClient();

  const { data: row, error: loadErr } = await supabase
    .from('photos')
    .select('id, job_id, storage_path')
    .eq('id', id)
    .maybeSingle();

  if (loadErr) {
    return { ok: false, error: `Failed to load photo: ${loadErr.message}` };
  }
  if (!row) {
    return { ok: false, error: 'Photo not found.' };
  }

  const storageRes = await deleteFromStorage(row.storage_path);
  if (storageRes.error) {
    return { ok: false, error: `Failed to delete file: ${storageRes.error}` };
  }

  const { error: delErr } = await supabase.from('photos').delete().eq('id', id);
  if (delErr) {
    return { ok: false, error: `Failed to delete row: ${delErr.message}` };
  }

  revalidatePath('/photos-demo');
  if (row.job_id) {
    revalidatePath(`/jobs/${row.job_id}`);
  }
  return { ok: true, id };
}

/** Metadata-only edit — tag and/or caption. */
export async function updatePhotoAction(formData: FormData): Promise<PhotoActionResult> {
  const raw = {
    id: String(formData.get('id') ?? ''),
    tag: formData.get('tag') ? String(formData.get('tag')) : undefined,
    caption: formData.get('caption') === null ? undefined : String(formData.get('caption') ?? ''),
  };

  const parsed = photoUpdateSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Please fix the errors below.',
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    };
  }

  const supabase = await createClient();
  const patch: Record<string, string | null> = { updated_at: new Date().toISOString() };
  if (parsed.data.tag) patch.tag = parsed.data.tag;
  if (parsed.data.caption !== undefined) {
    patch.caption = emptyToNull(parsed.data.caption);
  }

  const { data, error } = await supabase
    .from('photos')
    .update(patch)
    .eq('id', parsed.data.id)
    .select('id, job_id')
    .single();

  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Failed to update photo.' };
  }

  revalidatePath('/photos-demo');
  if (data.job_id) {
    revalidatePath(`/jobs/${data.job_id}`);
  }
  return { ok: true, id: parsed.data.id };
}

/**
 * Accept Henry's suggested tag: promote `ai_tag` into the canonical `tag`
 * field. Used by the "Henry thinks: X" pill on the photo card when the
 * operator taps to confirm. If `caption` is still blank and Henry has a
 * caption, promote that too.
 *
 * Always-legal operation (does not require a specific source state), since
 * the user can reassign at will via the regular update action.
 */
export async function acceptAiTagAction(photoId: string): Promise<PhotoActionResult> {
  if (!photoId || typeof photoId !== 'string') {
    return { ok: false, error: 'photoId is required' };
  }
  const supabase = await createClient();

  const { data: row, error: readErr } = await supabase
    .from('photos')
    .select('id, job_id, ai_tag, ai_caption, caption')
    .eq('id', photoId)
    .maybeSingle();
  if (readErr || !row) {
    return { ok: false, error: readErr?.message ?? 'Photo not found.' };
  }
  if (!row.ai_tag) {
    return { ok: false, error: 'Henry has no suggestion for this photo yet.' };
  }

  const patch: Record<string, string | null> = {
    tag: row.ai_tag as string,
    updated_at: new Date().toISOString(),
  };
  if (!row.caption && row.ai_caption) {
    patch.caption = row.ai_caption as string;
    patch.caption_source = 'ai';
  }

  const { error: updErr } = await supabase.from('photos').update(patch).eq('id', photoId);
  if (updErr) return { ok: false, error: updErr.message };

  if (row.job_id) revalidatePath(`/jobs/${row.job_id}`);
  return { ok: true, id: photoId };
}

/**
 * Derive a safe file extension from a File. We default to `.jpg` when the
 * name has no recognisable suffix (camera captures on iOS sometimes come in
 * without one). The extension is purely cosmetic — the bucket enforces no
 * MIME filter and the tag/caption metadata carries no extension assumption.
 */
function deriveExtension(file: File): string {
  const name = file.name ?? '';
  const dot = name.lastIndexOf('.');
  if (dot > -1 && dot < name.length - 1) {
    const ext = name.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
  }
  const mime = (file.type || '').toLowerCase();
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/gif') return 'gif';
  return 'jpg';
}
