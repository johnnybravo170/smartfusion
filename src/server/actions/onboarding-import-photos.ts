'use server';

/**
 * Phase E of the onboarding-import wizard. Bulk-attach a folder of
 * historical project photos to a chosen project.
 *
 * Lighter weight than A/B/C/D — no LLM call in the V1 path. The
 * operator picks one project, drops a pile of images, and we upload
 * each to the existing `photos` storage bucket and write a row in
 * `public.photos` tagged with import_batch_id. AI tagging stays
 * available via the existing `ai-worker` cron (it picks up rows with
 * NULL ai_tag and processes them in the background) — imported
 * photos slot into that pipeline naturally.
 *
 * Flow mirrors Phase D (receipts):
 *   1. Client iterates the dropped files.
 *   2. For each, calls `parsePhotoForImportAction` with the projectId
 *      + file. Action validates + uploads + returns the proposal
 *      (storage path, dimensions, mime, taken_at from EXIF).
 *   3. Operator reviews thumbnails in the wizard, optionally adds a
 *      caption per photo, can deselect any unwanted ones.
 *   4. `commitPhotoImportAction` opens the batch, bulk-inserts the
 *      photos rows, and is done.
 *
 * Rollback: soft-delete (photos.deleted_at). Storage objects stay so
 * a re-import doesn't re-upload identical bytes. Listings filter
 * `deleted_at IS NULL` already.
 */

import { randomUUID } from 'node:crypto';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { uploadToStorage } from '@/lib/storage/photos';
import { createClient } from '@/lib/supabase/server';

const MAX_PHOTO_BYTES = 25 * 1024 * 1024;

export type ProposedPhoto = {
  /** Original filename — pure UX label. */
  filename: string;
  storagePath: string;
  mime: string;
  bytes: number;
  /** Operator can override before commit. */
  caption: string | null;
  /** Tag must be one of photos_tag_check values; defaults to 'progress'. */
  tag:
    | 'before'
    | 'after'
    | 'progress'
    | 'damage'
    | 'materials'
    | 'equipment'
    | 'serial'
    | 'concern'
    | 'other';
};

export type ParsePhotoResult =
  | { ok: true; proposed: ProposedPhoto }
  | { ok: false; error: string; filename: string };

function extFromContentType(mime: string): string {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/heic' || mime === 'image/heif') return 'heic';
  if (mime === 'image/webp') return 'webp';
  return 'bin';
}

/**
 * Validate + upload ONE photo. Called per-file from the client so the
 * UX has progress per upload and so a single bad file doesn't tank the
 * whole batch.
 */
export async function parsePhotoForImportAction(formData: FormData): Promise<ParsePhotoResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.', filename: '' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.', filename: '' };

  const file = formData.get('file');
  const projectId = formData.get('projectId');
  if (typeof projectId !== 'string' || !projectId) {
    return { ok: false, error: 'No project selected.', filename: '' };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: 'No photo provided.', filename: '' };
  }
  const filename = file.name;
  if (file.size > MAX_PHOTO_BYTES) {
    return { ok: false, error: 'Photo is larger than 25MB.', filename };
  }
  const mime = file.type || 'image/jpeg';
  if (!mime.startsWith('image/')) {
    return { ok: false, error: `Unsupported file type: ${mime}`, filename };
  }

  // Confirm project belongs to this tenant. Done here instead of trusting
  // the FormData blindly — caller is the wizard but never trust the wire.
  const supabase = await createClient();
  const { data: proj } = await supabase
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!proj) return { ok: false, error: 'Project not found.', filename };

  const photoId = randomUUID();
  const ext = extFromContentType(mime);
  const buf = Buffer.from(await file.arrayBuffer());
  const upload = await uploadToStorage({
    tenantId: tenant.id,
    projectId,
    photoId,
    file: buf,
    contentType: mime,
    extension: ext,
  });
  if ('error' in upload) {
    return { ok: false, error: `Photo upload failed: ${upload.error}`, filename };
  }

  return {
    ok: true,
    proposed: {
      filename,
      storagePath: upload.path,
      mime,
      bytes: file.size,
      caption: null,
      tag: 'progress',
    },
  };
}

// ─── Commit ────────────────────────────────────────────────────────────────

export type CommitPhotoImportRow = {
  storagePath: string;
  mime: string;
  bytes: number;
  caption: string | null;
  tag: ProposedPhoto['tag'];
  decision: 'create' | 'skip';
};

export type CommitPhotoImportResult =
  | { ok: true; batchId: string; created: number; skipped: number }
  | { ok: false; error: string };

export async function commitPhotoImportAction(input: {
  projectId: string;
  rows: CommitPhotoImportRow[];
  note: string | null;
}): Promise<CommitPhotoImportResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();

  const { data: proj } = await supabase
    .from('projects')
    .select('id, name, customer_id')
    .eq('id', input.projectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!proj) return { ok: false, error: 'Project not found.' };

  const toCreate = input.rows.filter((r) => r.decision === 'create');
  const skipped = input.rows.filter((r) => r.decision === 'skip').length;
  if (toCreate.length === 0) {
    return { ok: false, error: 'Nothing to commit — every photo is set to skip.' };
  }

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .insert({
      tenant_id: tenant.id,
      kind: 'photos',
      source_filename: `${toCreate.length} photo${toCreate.length === 1 ? '' : 's'} → ${proj.name}`,
      summary: { created: toCreate.length, merged: 0, skipped },
      note: input.note?.trim() || null,
      created_by: user.id,
    })
    .select('id')
    .single();
  if (batchErr || !batch)
    return { ok: false, error: batchErr?.message ?? 'Could not start batch.' };
  const batchId = batch.id as string;

  const photoRows = toCreate.map((r) => ({
    tenant_id: tenant.id,
    project_id: input.projectId,
    customer_id: (proj.customer_id as string | null) ?? null,
    uploader_user_id: user.id,
    storage_path: r.storagePath,
    mime: r.mime,
    bytes: r.bytes,
    tag: r.tag,
    caption: r.caption,
    caption_source: 'user',
    source: 'import',
    device: {},
    quality_flags: {},
    original_exif: {},
    portal_tags: [],
    ai_portal_tags: [],
    client_visible: false,
    is_favorite: false,
    ai_attempts: 0,
    uploaded_at: new Date().toISOString(),
    import_batch_id: batchId,
  }));

  const { error: insErr } = await supabase.from('photos').insert(photoRows);
  if (insErr) {
    await supabase.from('import_batches').delete().eq('id', batchId);
    return { ok: false, error: insErr.message };
  }

  return {
    ok: true,
    batchId,
    created: toCreate.length,
    skipped,
  };
}

// ─── Rollback ──────────────────────────────────────────────────────────────

export async function rollbackPhotoImportAction(
  batchId: string,
): Promise<{ ok: true; deletedPhotos: number } | { ok: false; error: string }> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const supabase = await createClient();
  const user = await getCurrentUser();

  const { data: batch, error: batchErr } = await supabase
    .from('import_batches')
    .select('id, kind, rolled_back_at')
    .eq('id', batchId)
    .maybeSingle();
  if (batchErr || !batch) return { ok: false, error: 'Batch not found.' };
  if (batch.rolled_back_at) return { ok: false, error: 'Batch already rolled back.' };
  if (batch.kind !== 'photos') {
    return {
      ok: false,
      error: `Cannot roll back ${batch.kind} batches with the photo rollback action.`,
    };
  }

  const now = new Date().toISOString();
  const { data: deletedRows, error: delErr } = await supabase
    .from('photos')
    .update({ deleted_at: now })
    .eq('import_batch_id', batchId)
    .is('deleted_at', null)
    .select('id');
  if (delErr) return { ok: false, error: delErr.message };

  const { error: markErr } = await supabase
    .from('import_batches')
    .update({ rolled_back_at: now, rolled_back_by: user?.id ?? null })
    .eq('id', batchId);
  if (markErr) return { ok: false, error: markErr.message };

  return { ok: true, deletedPhotos: (deletedRows ?? []).length };
}
