'use server';

/**
 * Fetch a Web-Share-Target staged file and hand it back to the browser
 * as base64 so the intake zone can re-add it to its `staged` list.
 *
 * After a successful handoff we delete the storage object — the file
 * belongs to one parse attempt and shouldn't accumulate.
 */

import { getCurrentTenant } from '@/lib/auth/helpers';
import { createAdminClient } from '@/lib/supabase/admin';

const BUCKET = 'share-drafts';

export type ShareIntakeResult =
  | {
      ok: true;
      /** Base64-encoded file body (no data: prefix). */
      data: string;
      contentType: string;
      filename: string;
    }
  | { ok: false; error: string };

export async function fetchSharedFileAction(input: {
  token: string;
  filename?: string;
}): Promise<ShareIntakeResult> {
  const tenant = await getCurrentTenant();
  if (!tenant) return { ok: false, error: 'Not signed in.' };

  const token = String(input.token ?? '').trim();
  if (!/^[a-f0-9-]{36}$/i.test(token)) {
    return { ok: false, error: 'Invalid share token.' };
  }

  const admin = createAdminClient();

  // List objects under the tenant's folder and find one whose name matches
  // the token UUID (extension varies: .jpg / .pdf / etc.).
  const { data: listing, error: listErr } = await admin.storage
    .from(BUCKET)
    .list(tenant.id, { limit: 100, search: token });
  if (listErr) return { ok: false, error: listErr.message };
  const match = listing?.find((o) => o.name.startsWith(`${token}.`));
  if (!match) return { ok: false, error: 'Shared file not found or expired.' };

  const storagePath = `${tenant.id}/${match.name}`;

  const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(storagePath);
  if (dlErr || !blob) return { ok: false, error: dlErr?.message ?? 'Could not read file.' };

  const buf = Buffer.from(await blob.arrayBuffer());
  const base64 = buf.toString('base64');

  const guessedContentType =
    blob.type ||
    (match.name.endsWith('.pdf')
      ? 'application/pdf'
      : match.name.endsWith('.png')
        ? 'image/png'
        : match.name.endsWith('.webp')
          ? 'image/webp'
          : match.name.endsWith('.heic') || match.name.endsWith('.heif')
            ? 'image/heic'
            : 'image/jpeg');

  // Fire-and-forget cleanup. Failure here is not fatal — the file will
  // get swept by a future cron. (Log so we notice if it happens often.)
  admin.storage
    .from(BUCKET)
    .remove([storagePath])
    .then(({ error }) => {
      if (error) console.warn('share-drafts cleanup failed:', error.message);
    });

  return {
    ok: true,
    data: base64,
    contentType: guessedContentType,
    filename: input.filename || match.name,
  };
}
