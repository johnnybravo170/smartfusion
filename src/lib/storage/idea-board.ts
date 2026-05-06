/**
 * Storage helpers for customer idea-board image uploads.
 *
 * Reuses the `photos` bucket under a dedicated path prefix
 * `${tenantId}/idea-board-${projectId}/${itemId}.${ext}` to avoid
 * standing up a new bucket. The first segment is the tenant id, which
 * is what the photos bucket's RLS policies validate against.
 *
 * Idea-board images do NOT get a companion `photos` table row — they're
 * scratchpad inputs, not gallery photos. Mixing them would require every
 * photos query to filter `kind != 'idea_board'`.
 *
 * Customer-side writes happen via the admin client (portal_slug auth has
 * no Supabase auth context); the helpers below take the supabase client
 * as an argument so the same helpers work for both server-action and
 * admin-client paths.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const BUCKET = 'photos';
const DEFAULT_SIGN_EXPIRES_SECONDS = 3600;

export function ideaBoardStoragePath(args: {
  tenantId: string;
  projectId: string;
  itemId: string;
  extension?: string;
}): string {
  const ext = (args.extension ?? 'jpg').replace(/^\./, '');
  return `${args.tenantId}/idea-board-${args.projectId}/${args.itemId}.${ext}`;
}

export async function uploadIdeaBoardImage(
  supabase: SupabaseClient,
  args: {
    storagePath: string;
    file: Blob | Buffer;
    contentType: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const body =
    args.file instanceof Buffer ? new Blob([new Uint8Array(args.file)]) : (args.file as Blob);
  const { error } = await supabase.storage.from(BUCKET).upload(args.storagePath, body, {
    contentType: args.contentType,
    upsert: false,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteIdeaBoardImage(
  supabase: SupabaseClient,
  storagePath: string,
): Promise<void> {
  await supabase.storage.from(BUCKET).remove([storagePath]);
}

export async function signIdeaBoardImageUrls(
  supabase: SupabaseClient,
  storagePaths: string[],
  expiresIn: number = DEFAULT_SIGN_EXPIRES_SECONDS,
): Promise<Map<string, string>> {
  if (storagePaths.length === 0) return new Map();
  const { data } = await supabase.storage.from(BUCKET).createSignedUrls(storagePaths, expiresIn);
  const out = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  }
  return out;
}
