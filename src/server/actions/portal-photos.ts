'use server';

/**
 * Server actions for portal-publishing photos. Slice 2 of the Customer
 * Portal & Home Record build.
 *
 * Photos already exist in `photos` with a single internal `tag`. These
 * actions touch only the `portal_tags` array (multi-valued, homeowner-
 * facing vocabulary) and `client_visible` flag — the internal tag stays
 * untouched so the gallery / AI / favorites flows are unaffected.
 *
 * Tenant isolation runs through RLS on the `photos` table.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { sanitizePortalPhotoTags } from '@/lib/validators/portal-photo';

export type PortalPhotoActionResult = { ok: true } | { ok: false; error: string };

/**
 * Replace the portal_tags array on a single photo. Pass an empty array to
 * un-publish (photo no longer appears in the homeowner gallery).
 *
 * Caller passes `projectId` only so we can `revalidatePath` the right
 * pages. Authorization happens via RLS on the photo row.
 */
export async function setPhotoPortalTagsAction(
  photoId: string,
  tags: string[],
  projectId: string,
): Promise<PortalPhotoActionResult> {
  const sanitized = sanitizePortalPhotoTags(tags);
  const supabase = await createClient();
  const { error } = await supabase
    .from('photos')
    .update({ portal_tags: sanitized })
    .eq('id', photoId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Hide / unhide a tagged photo from the homeowner without un-tagging it.
 * Useful when the photo is tagged 'issue' for triage but not yet ready
 * for the client to see.
 */
export async function togglePhotoClientVisibleAction(
  photoId: string,
  visible: boolean,
  projectId: string,
): Promise<PortalPhotoActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from('photos')
    .update({ client_visible: visible })
    .eq('id', photoId);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
