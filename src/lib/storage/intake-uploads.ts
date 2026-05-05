/**
 * Shared client-side helpers for intake uploads — used by both the deep
 * LeadIntakeForm and the slim IntakeAccelerator. Two responsibilities:
 *
 *   1. `shrinkIfNeeded(file)` — convert HEIC/AVIF/WebP to JPEG (OpenAI
 *      Vision only accepts png/jpeg/gif/webp) and downscale large
 *      images so we don't blow past the 4.5 MB Vercel server-action
 *      body cap. PDFs pass through untouched.
 *   2. `uploadIntakeFiles(files, supabase)` — uploads each prepared
 *      file into the `intake-audio` bucket (historical name; covers
 *      images + PDFs + voice) and returns storage entries shaped for
 *      `parseInboundLeadAction`'s FormData.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resizeImage } from '@/lib/storage/resize-image';

const RESIZE_THRESHOLD_BYTES = 2 * 1024 * 1024;
const OPENAI_FRIENDLY_IMAGE = /^image\/(jpeg|jpg|png|gif|webp)$/i;

export async function shrinkIfNeeded(file: File): Promise<File> {
  if (file.type === 'application/pdf') return file;
  if (!file.type.startsWith('image/')) return file;

  const needsFormatConversion = !OPENAI_FRIENDLY_IMAGE.test(file.type);
  const needsShrink = file.size > RESIZE_THRESHOLD_BYTES;
  if (!needsFormatConversion && !needsShrink) return file;

  try {
    const blob = await resizeImage(file, { maxDimension: 2048, quality: 0.85 });
    const newName = file.name.replace(/\.(heic|heif|png|webp|avif)$/i, '.jpg');
    return new File([blob], newName || 'image.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export type IntakeStorageEntry = { path: string; name: string };

/**
 * Uploads each file into `intake-audio` under `tenant/<userId>/<uuid>.<ext>`
 * (the path layout matches the bucket's RLS — foldername[2] = auth.uid()).
 * Returns the storage entries the server action expects, or throws on
 * the first failure so the caller can surface a single toast.
 */
export async function uploadIntakeFiles(
  files: File[],
  supabase: SupabaseClient,
): Promise<IntakeStorageEntry[]> {
  if (files.length === 0) return [];

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) {
    throw new Error('Sign in again before uploading.');
  }

  const entries: IntakeStorageEntry[] = [];
  for (const raw of files) {
    const prepared = await shrinkIfNeeded(raw);
    const ext = prepared.name.split('.').pop()?.toLowerCase() || 'bin';
    const path = `tenant/${userId}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('intake-audio').upload(path, prepared, {
      contentType: prepared.type || 'application/octet-stream',
    });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    entries.push({ path, name: prepared.name || raw.name || 'file' });
  }
  return entries;
}
