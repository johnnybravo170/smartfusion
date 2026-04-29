/**
 * Thin wrappers around Supabase Storage for the `project-checklist` bucket.
 *
 * Mirrors `src/lib/storage/photos.ts` but for the field-checklist bucket so
 * the gallery photo flow doesn't accidentally surface or operate on these
 * ephemeral attachments. Path convention enforced by storage RLS:
 * `{tenant_id}/{project_id}/{item_id}.{ext}`.
 */

import { createClient } from '@/lib/supabase/server';

const BUCKET = 'project-checklist';
const DEFAULT_SIGN_EXPIRES_SECONDS = 3600;

export type UploadArgs = {
  tenantId: string;
  projectId: string;
  itemId: string;
  file: Blob | Buffer;
  contentType: string;
  /** Defaults to `.jpg`. */
  extension?: string;
};

export type UploadResult = { path: string } | { error: string };

export async function uploadChecklistAttachment(args: UploadArgs): Promise<UploadResult> {
  const supabase = await createClient();
  const ext = (args.extension ?? 'jpg').replace(/^\./, '');
  const path = `${args.tenantId}/${args.projectId}/${args.itemId}.${ext}`;

  const body = args.file instanceof Buffer ? new Blob([new Uint8Array(args.file)]) : args.file;

  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: args.contentType,
    upsert: true, // checklist photo can be replaced
  });

  if (error) return { error: error.message };
  return { path };
}

export async function getChecklistSignedUrl(
  storagePath: string,
  expiresIn: number = DEFAULT_SIGN_EXPIRES_SECONDS,
): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data) return null;
  return data.signedUrl;
}

export async function getChecklistSignedUrls(
  storagePaths: string[],
  expiresIn: number = DEFAULT_SIGN_EXPIRES_SECONDS,
): Promise<Map<string, string>> {
  if (storagePaths.length === 0) return new Map();
  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(storagePaths, expiresIn);
  const urlMap = new Map<string, string>();
  if (error || !data) return urlMap;
  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (entry.signedUrl && !entry.error) {
      urlMap.set(storagePaths[i], entry.signedUrl);
    }
  }
  return urlMap;
}

export async function deleteChecklistAttachment(storagePath: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) return { error: error.message };
  return {};
}
