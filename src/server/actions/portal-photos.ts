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

/**
 * Attach the photo to a phase (or detach by passing null). Powers the
 * inline-on-timeline rendering on /portal/<slug> and on the Home Record.
 */
export async function setPhotoPhaseAction(
  photoId: string,
  phaseId: string | null,
  projectId: string,
): Promise<PortalPhotoActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from('photos').update({ phase_id: phaseId }).eq('id', photoId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Bulk operations for the gallery's "Select multiple" mode. All three
 * accept an array of photo IDs and apply the same change in one round
 * trip. RLS on the photos table covers tenant isolation.
 */
export async function setPhotosPortalTagsBulkAction(
  photoIds: string[],
  tags: string[],
  projectId: string,
): Promise<PortalPhotoActionResult> {
  if (photoIds.length === 0) return { ok: true };
  const sanitized = sanitizePortalPhotoTags(tags);
  const supabase = await createClient();
  const { error } = await supabase
    .from('photos')
    .update({ portal_tags: sanitized })
    .in('id', photoIds);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function setPhotosPhaseBulkAction(
  photoIds: string[],
  phaseId: string | null,
  projectId: string,
): Promise<PortalPhotoActionResult> {
  if (photoIds.length === 0) return { ok: true };
  const supabase = await createClient();
  const { error } = await supabase.from('photos').update({ phase_id: phaseId }).in('id', photoIds);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

export async function setPhotosClientVisibleBulkAction(
  photoIds: string[],
  visible: boolean,
  projectId: string,
): Promise<PortalPhotoActionResult> {
  if (photoIds.length === 0) return { ok: true };
  const supabase = await createClient();
  const { error } = await supabase
    .from('photos')
    .update({ client_visible: visible })
    .in('id', photoIds);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

/**
 * Run Henry's portal-aware enricher on a single photo. Reads the
 * photo's bytes via signed URL (admin client to bypass RLS), calls
 * Claude Haiku, and writes the suggestions to ai_portal_tags +
 * ai_portal_caption. Returns the suggestions so the caller can show
 * them inline without a refetch.
 *
 * Best-effort: returns ok:false with a friendly error if anything
 * fails, but never persists half-state.
 */
export type EnrichPhotoResult =
  | { ok: true; portalTags: string[]; portalCaption: string }
  | { ok: false; error: string };

export async function enrichPhotoForPortalAction(
  photoId: string,
  projectId: string,
): Promise<EnrichPhotoResult> {
  const supabase = await createClient();
  const { data: row } = await supabase
    .from('photos')
    .select('id, storage_path, mime')
    .eq('id', photoId)
    .single();
  if (!row) return { ok: false, error: 'Photo not found.' };

  // Use admin to fetch bytes — RLS would also work via the regular
  // client but admin keeps the path consistent with how the home
  // record / PDF embedding pipelines fetch image bytes.
  const { createAdminClient } = await import('@/lib/supabase/admin');
  const admin = createAdminClient();
  const path = (row as Record<string, unknown>).storage_path as string;
  const { data: signed } = await admin.storage.from('photos').createSignedUrl(path, 600);
  if (!signed?.signedUrl) return { ok: false, error: 'Could not access photo.' };
  const res = await fetch(signed.signedUrl);
  if (!res.ok) return { ok: false, error: 'Could not download photo.' };
  const bytes = Buffer.from(await res.arrayBuffer());
  const mime = ((row as Record<string, unknown>).mime as string | null) ?? 'image/jpeg';

  const { enrichPhotoForPortal } = await import('@/lib/photos/ai-portal-enricher');
  let suggestion: { portalTags: string[]; portalCaption: string };
  try {
    const result = await enrichPhotoForPortal({ imageBytes: bytes, mimeType: mime });
    suggestion = { portalTags: result.portalTags, portalCaption: result.portalCaption };
  } catch (err) {
    return { ok: false, error: `Henry: ${err instanceof Error ? err.message : String(err)}` };
  }

  const { error: updErr } = await supabase
    .from('photos')
    .update({
      ai_portal_tags: suggestion.portalTags,
      ai_portal_caption: suggestion.portalCaption || null,
    })
    .eq('id', photoId);
  if (updErr) return { ok: false, error: updErr.message };

  revalidatePath(`/projects/${projectId}`);
  return { ok: true, ...suggestion };
}

/**
 * Promote Henry's suggestions into the canonical portal_tags + caption.
 * Used by the "Apply Henry's tags" button on the photo card. Doesn't
 * touch the existing internal `tag` (operator-controlled) or
 * `client_visible` (defaults to true on first publish).
 */
export async function applyHenryPortalSuggestionAction(
  photoId: string,
  projectId: string,
): Promise<PortalPhotoActionResult> {
  const supabase = await createClient();
  const { data: row } = await supabase
    .from('photos')
    .select('ai_portal_tags, ai_portal_caption, caption')
    .eq('id', photoId)
    .single();
  if (!row) return { ok: false, error: 'Photo not found.' };
  const r = row as Record<string, unknown>;
  const aiTags = ((r.ai_portal_tags as string[] | null) ?? []) as string[];
  const aiCaption = (r.ai_portal_caption as string | null) ?? null;
  const existingCaption = (r.caption as string | null) ?? null;

  const patch: Record<string, unknown> = {
    portal_tags: sanitizePortalPhotoTags(aiTags),
  };
  // Only fill caption if there isn't one already — never overwrite the
  // operator's words.
  if (aiCaption && !existingCaption) {
    patch.caption = aiCaption;
  }

  const { error } = await supabase.from('photos').update(patch).eq('id', photoId);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}
