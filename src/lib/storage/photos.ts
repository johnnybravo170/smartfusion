/**
 * Thin wrappers around Supabase Storage for the `photos` bucket.
 *
 * Every call uses the server client (cookie-bound), so RLS on
 * `storage.objects` runs with the user's JWT. The path convention
 * `{tenant_id}/{job_id}/{photo_id}.{ext}` is enforced by 0020's policies.
 *
 * All three helpers return a plain object rather than throwing so server
 * actions can surface storage errors to the user without wrapping each call
 * in try/catch.
 */

import { createClient } from '@/lib/supabase/server';

const BUCKET = 'photos';
const DEFAULT_SIGN_EXPIRES_SECONDS = 3600;

export type UploadArgs = {
  tenantId: string;
  jobId: string;
  photoId: string;
  file: Blob | Buffer;
  contentType: string;
  /** Defaults to `.jpg`. Use to preserve original extension if needed. */
  extension?: string;
};

export type UploadResult = { path: string } | { error: string };

/**
 * Writes a photo to storage under `${tenantId}/${jobId}/${photoId}.${ext}`.
 * RLS on `storage.objects` gatekeeps the write; if the tenant doesn't match
 * the caller's `current_tenant_id()`, Supabase returns a permission error.
 */
export async function uploadToStorage(args: UploadArgs): Promise<UploadResult> {
  const supabase = await createClient();
  const ext = (args.extension ?? 'jpg').replace(/^\./, '');
  const path = `${args.tenantId}/${args.jobId}/${args.photoId}.${ext}`;

  const body = args.file instanceof Buffer ? new Blob([new Uint8Array(args.file)]) : args.file;

  const { error } = await supabase.storage.from(BUCKET).upload(path, body, {
    contentType: args.contentType,
    upsert: false,
  });

  if (error) return { error: error.message };
  return { path };
}

/**
 * Signs a temporary read URL for a storage path. Returns `null` if signing
 * fails (object missing, permission denied under RLS, etc) — callers render
 * a broken-image placeholder rather than propagating the error.
 */
export async function getSignedUrl(
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

/**
 * Deletes a storage object. The caller is expected to also delete the
 * companion `photos` row in the same action.
 */
export async function deleteFromStorage(storagePath: string): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.storage.from(BUCKET).remove([storagePath]);
  if (error) return { error: error.message };
  return {};
}
